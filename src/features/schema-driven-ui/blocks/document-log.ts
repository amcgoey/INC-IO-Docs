import type { UiViewSection, UiViewWidget } from '../domain';
import type { DocumentLogPanelContext, DocumentLogPanelEntry } from '../ports';
import { PRIMARY_ACTION_BUTTON_COLOR, escapeCardHtml } from './common';

export const SELECT_DOCUMENT_LOG_KEY = 'SelectDocumentLog';
const MAX_HISTORY_ROWS_CAP = 20;

export interface DocumentLogSectionOptions {
  sectionHeader?: string | undefined;
  maxWidgets?: number | undefined;
  actionParameters?: Record<string, unknown> | undefined;
}

function buildOpenLinkButton(text: string, url: string) {
  return {
    text,
    onClick: {
      openLink: {
        url,
        openAs: 'FULL_SIZE' as const,
      },
    },
  };
}

function buildActiveLogBottomLabel(
  context: DocumentLogPanelContext,
  plainFolder: string | undefined,
  includeFolder: boolean
): string | undefined {
  const folderPrefix = includeFolder && plainFolder ? `Folder: ${plainFolder}` : undefined;
  if (context.readStatus === undefined) {
    return folderPrefix;
  }

  const plainIdGroup = context.idGroup?.trim() || undefined;
  let statusSummary: string;
  switch (context.readStatus) {
    case 'idle_incomplete_id':
      statusSummary = 'Enter ID fields for history';
      break;
    case 'read_error':
      statusSummary = 'History unavailable';
      break;
    case 'ready':
    case 'partial_hydration': {
      const count = context.entries?.length ?? 0;
      const countText =
        count === 0 ? 'No prior entries' : `${count} ${count === 1 ? 'entry' : 'entries'}`;
      statusSummary = plainIdGroup ? `${countText} for ${plainIdGroup}` : countText;
      break;
    }
  }

  return folderPrefix ? `${folderPrefix} · ${statusSummary}` : statusSummary;
}

function buildHistoryEntryWidget(entry: DocumentLogPanelEntry): UiViewWidget {
  const trimmedUri = entry.fileUri?.trim();
  return {
    decoratedText: {
      ...(entry.topLabel !== undefined && entry.topLabel.length > 0
        ? { topLabel: entry.topLabel }
        : {}),
      text: entry.text,
      wrapText: true,
      ...(entry.bottomLabel !== undefined && entry.bottomLabel.length > 0
        ? { bottomLabel: entry.bottomLabel }
        : {}),
      ...(trimmedUri && trimmedUri.length > 0
        ? { button: buildOpenLinkButton('Open', trimmedUri) }
        : {}),
    },
  };
}

/**
 * Appends pre-submit read status, warning banners, empty-history guidance, and newest-first
 * collapsible `idGroup` history rows onto `widgets`, enforcing the 20-row history cap and
 * overflow-first `maxWidgets` budget so the card stays strictly <= 100 widgets.
 */
function appendReadStateAndHistoryWidgets(params: {
  context: DocumentLogPanelContext;
  widgets: UiViewWidget[];
  maxWidgets: number | undefined;
}): { renderedHistoryRows: number; uncollapsibleCount: number } {
  const { context, widgets, maxWidgets } = params;
  if (context.readStatus === undefined) {
    return { renderedHistoryRows: 0, uncollapsibleCount: 0 };
  }

  const plainIdGroup = context.idGroup?.trim() || undefined;

  if (context.readStatus === 'idle_incomplete_id') {
    const missingFields = (context.missingIdFields ?? [])
      .map((field) => field.trim())
      .filter((field) => field.length > 0);
    const guidance =
      missingFields.length > 0
        ? `Enter ${missingFields.map((field) => `<b>${escapeCardHtml(field)}</b>`).join(', ')} to view prior Document Log history.`
        : 'Enter required ID fields to view prior Document Log history.';
    widgets.push({ textParagraph: { text: guidance } });
    return { renderedHistoryRows: 0, uncollapsibleCount: 0 };
  }

  if (context.readStatus === 'read_error') {
    const detail = context.readErrorMessage?.trim();
    const escapedErr = detail
      ? escapeCardHtml(detail)
      : 'Unable to load Document Log history right now.';
    const idSuffix = plainIdGroup ? ` for <b>${escapeCardHtml(plainIdGroup)}</b>` : '';
    widgets.push({
      textParagraph: {
        text: `<font color="#b06000"><b>Document Log history unavailable${idSuffix}:</b></font> ${escapedErr}`,
      },
    });
    return { renderedHistoryRows: 0, uncollapsibleCount: 0 };
  }

  const hasPartialWarning = context.readStatus === 'partial_hydration';
  if (hasPartialWarning) {
    const warningMessages = (context.warningMessages ?? [])
      .map((msg) => msg.trim())
      .filter((msg) => msg.length > 0);
    const bannerText =
      warningMessages.length > 0
        ? `<font color="#b06000"><b>Partial read (${warningMessages.length} ${warningMessages.length === 1 ? 'warning' : 'warnings'}):</b></font> ${warningMessages.map((msg) => escapeCardHtml(msg)).join('<br>')}`
        : '<font color="#b06000"><b>Partial read:</b></font> Some rows in the Document Log could not be fully validated.';
    widgets.push({ textParagraph: { text: bannerText } });
  }

  const entries = context.entries ?? [];
  if (entries.length === 0) {
    widgets.push({
      textParagraph: {
        text: plainIdGroup
          ? `No prior Document Log entries found for <b>${escapeCardHtml(plainIdGroup)}</b>.`
          : 'No prior Document Log entries found.',
      },
    });
    return { renderedHistoryRows: 0, uncollapsibleCount: 0 };
  }

  const logFixedWidgets = widgets.length;
  let displayCount: number;
  let showOverflowNotice: boolean;

  if (maxWidgets !== undefined) {
    const rawBudget = Math.max(0, maxWidgets - logFixedWidgets);
    const maxWithoutOverflow = Math.min(MAX_HISTORY_ROWS_CAP, rawBudget);
    if (entries.length <= maxWithoutOverflow) {
      displayCount = entries.length;
      showOverflowNotice = false;
    } else if (rawBudget >= 1) {
      displayCount = Math.max(0, Math.min(MAX_HISTORY_ROWS_CAP, rawBudget - 1));
      showOverflowNotice = true;
    } else {
      displayCount = 0;
      showOverflowNotice = false;
    }
  } else if (entries.length <= MAX_HISTORY_ROWS_CAP) {
    displayCount = entries.length;
    showOverflowNotice = false;
  } else {
    displayCount = MAX_HISTORY_ROWS_CAP;
    showOverflowNotice = true;
  }

  for (const entry of entries.slice(0, displayCount)) {
    widgets.push(buildHistoryEntryWidget(entry));
  }

  if (showOverflowNotice) {
    widgets.push({
      decoratedText: {
        text: `Showing ${displayCount} of ${entries.length} entries`,
        wrapText: true,
        ...(context.activeCandidate
          ? { button: buildOpenLinkButton('Open Log', context.activeCandidate.url) }
          : {}),
      },
    });
  }

  return {
    renderedHistoryRows: displayCount,
    uncollapsibleCount: logFixedWidgets,
  };
}

/**
 * Pure, host- and trigger-agnostic UiBlock presenting DocumentLog resolution state
 * and collapsible prior `idGroup` history between File Selection and Document Data.
 */
export function buildDocumentLogSection(
  context: DocumentLogPanelContext | undefined,
  options?: DocumentLogSectionOptions
): UiViewSection | undefined {
  if (!context) {
    return undefined;
  }
  if (options?.maxWidgets !== undefined && options.maxWidgets <= 0) {
    return undefined;
  }

  const header = options?.sectionHeader ?? 'Document Log';
  const widgets: UiViewWidget[] = [];
  const plainSpace = context.spaceName?.trim() || undefined;
  const plainFolder = context.targetFolderPath?.trim() || undefined;
  const escapedSpace = plainSpace ? escapeCardHtml(plainSpace) : undefined;
  let renderedHistoryRows = 0;
  let uncollapsibleCount = 0;

  switch (context.status) {
    case 'missing_space': {
      widgets.push({
        textParagraph: {
          text: 'Select a <b>Document Space</b> to locate or create a Document Log.',
        },
      });
      break;
    }

    case 'discovery_error': {
      const detail = context.discoveryErrorMessage?.trim();
      const escapedMsg = detail
        ? escapeCardHtml(detail)
        : 'Unable to check Google Drive for a Document Log right now.';
      widgets.push({
        textParagraph: {
          text: `<font color="#b06000"><b>Document Log lookup unavailable:</b></font> ${escapedMsg}`,
        },
      });
      break;
    }

    case 'missing': {
      const targetFile = context.targetFileName?.trim() || 'Document Log';
      const escapedFile = escapeCardHtml(targetFile);
      widgets.push({
        textParagraph: {
          text: escapedSpace
            ? `<font color="#b06000"><b>No Document Log found</b></font> in <b>${escapedSpace}</b>.`
            : '<font color="#b06000"><b>No Document Log found.</b></font>',
        },
      });
      widgets.push({
        decoratedText: {
          topLabel: plainSpace ? `Expected in ${plainSpace}` : 'Expected Document Log',
          text: `<b>${escapedFile}</b>`,
          wrapText: true,
          ...(plainFolder !== undefined ? { bottomLabel: `Folder: ${plainFolder}` } : {}),
        },
      });
      const hasActionParams =
        options?.actionParameters !== undefined &&
        Object.keys(options.actionParameters).length > 0;
      widgets.push({
        buttonList: {
          buttons: [
            {
              text: 'Copy Log',
              color: PRIMARY_ACTION_BUTTON_COLOR,
              onClick: {
                action: 'copyDocumentLog',
                ...(hasActionParams ? { parameters: options.actionParameters } : {}),
              },
            },
          ],
        },
      });
      break;
    }

    case 'resolved': {
      const active = context.activeCandidate;
      const bottomLabel = buildActiveLogBottomLabel(context, plainFolder, true);
      widgets.push({
        decoratedText: {
          topLabel: plainSpace ? `Active Document Log · ${plainSpace}` : 'Active Document Log',
          text: active ? `<b>${escapeCardHtml(active.name)}</b>` : 'Document Log resolved',
          wrapText: true,
          ...(bottomLabel !== undefined ? { bottomLabel } : {}),
          ...(active ? { button: buildOpenLinkButton('Open Log', active.url) } : {}),
        },
      });
      const historyStats = appendReadStateAndHistoryWidgets({
        context,
        widgets,
        maxWidgets: options?.maxWidgets,
      });
      renderedHistoryRows = historyStats.renderedHistoryRows;
      uncollapsibleCount = historyStats.uncollapsibleCount;
      break;
    }

    case 'ambiguous': {
      const candidateOptions = context.candidateOptions ?? [];
      const onChangeParams =
        options?.actionParameters && Object.keys(options.actionParameters).length > 0
          ? options.actionParameters
          : undefined;
      if (candidateOptions.length > 0) {
        widgets.push({
          selectionInput: {
            name: SELECT_DOCUMENT_LOG_KEY,
            label: `Document Log (${candidateOptions.length} found)`,
            type: 'DROPDOWN',
            items: candidateOptions,
            onChangeAction: {
              action: 'onFormChange',
              ...(onChangeParams !== undefined ? { parameters: onChangeParams } : {}),
            },
          },
        });
      }
      const active = context.activeCandidate;
      if (active) {
        const bottomLabel = buildActiveLogBottomLabel(context, plainFolder, false);
        widgets.push({
          decoratedText: {
            topLabel: plainSpace ? `Active Document Log · ${plainSpace}` : 'Active Document Log',
            text: `<b>${escapeCardHtml(active.name)}</b>`,
            wrapText: true,
            ...(bottomLabel !== undefined ? { bottomLabel } : {}),
            button: buildOpenLinkButton('Open Log', active.url),
          },
        });
        const historyStats = appendReadStateAndHistoryWidgets({
          context,
          widgets,
          maxWidgets: options?.maxWidgets,
        });
        renderedHistoryRows = historyStats.renderedHistoryRows;
        uncollapsibleCount = historyStats.uncollapsibleCount;
      } else if (candidateOptions.length === 0) {
        widgets.push({
          textParagraph: {
            text: escapedSpace
              ? `<font color="#b06000"><b>Multiple Document Logs found</b></font> in <b>${escapedSpace}</b>.`
              : '<font color="#b06000"><b>Multiple Document Logs found.</b></font>',
          },
        });
      }
      break;
    }
  }

  const finalWidgets =
    options?.maxWidgets !== undefined && widgets.length > options.maxWidgets
      ? widgets.slice(0, options.maxWidgets)
      : widgets;

  if (finalWidgets.length === 0) {
    return undefined;
  }

  return {
    header,
    widgets: finalWidgets,
    ...(renderedHistoryRows >= 1
      ? {
          collapsible: true,
          uncollapsibleWidgetsCount: uncollapsibleCount,
        }
      : {}),
  };
}

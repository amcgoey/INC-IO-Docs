import type { UiViewSection, UiViewWidget } from '../domain';
import type { DocumentLogPanelContext } from '../ports';
import { PRIMARY_ACTION_BUTTON_COLOR, escapeCardHtml } from './common';

export interface DocumentLogSectionOptions {
  sectionHeader?: string | undefined;
  maxWidgets?: number | undefined;
  actionParameters?: Record<string, unknown> | undefined;
}

function buildOpenLogButton(url: string) {
  return {
    text: 'Open Log',
    onClick: {
      openLink: {
        url,
        openAs: 'FULL_SIZE' as const,
      },
    },
  };
}

/**
 * Pure, host- and trigger-agnostic UiBlock presenting DocumentLog resolution state
 * between File Selection and Document Data.
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
      widgets.push({
        decoratedText: {
          topLabel: plainSpace ? `Active Document Log · ${plainSpace}` : 'Active Document Log',
          text: active ? `<b>${escapeCardHtml(active.name)}</b>` : 'Document Log resolved',
          wrapText: true,
          ...(plainFolder !== undefined ? { bottomLabel: `Folder: ${plainFolder}` } : {}),
          ...(active ? { button: buildOpenLogButton(active.url) } : {}),
        },
      });
      break;
    }

    case 'ambiguous': {
      const active = context.activeCandidate;
      widgets.push({
        textParagraph: {
          text: escapedSpace
            ? `<font color="#b06000"><b>Multiple Document Logs found</b></font> in <b>${escapedSpace}</b>.`
            : '<font color="#b06000"><b>Multiple Document Logs found.</b></font>',
        },
      });
      if (active) {
        widgets.push({
          decoratedText: {
            topLabel: 'Top Ranked Candidate',
            text: `<b>${escapeCardHtml(active.name)}</b>`,
            wrapText: true,
            ...(plainFolder !== undefined ? { bottomLabel: `Folder: ${plainFolder}` } : {}),
            button: buildOpenLogButton(active.url),
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
  };
}

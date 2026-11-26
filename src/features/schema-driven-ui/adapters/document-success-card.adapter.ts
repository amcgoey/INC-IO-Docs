import type { UiView, UiViewHeader, UiViewSection, UiViewWidget } from '../domain';
import type {
  DocumentTypeDisplayNameResolverPort,
  ExecutionFileLocator,
  UiViewAdapterContext,
  UiViewSchemaAdapterPort,
} from '../ports';
import { escapeCardHtml } from '../blocks/common';

export const DOCUMENT_SUCCESS_CARD_VIEW_ID = 'document-success-card';

function collectCreatedAndFiledFiles(
  stepResults: NonNullable<UiViewAdapterContext['executionOutcome']>['stepResults']
): ExecutionFileLocator[] {
  const seenIds = new Set<string>();
  const files: ExecutionFileLocator[] = [];

  for (const step of stepResults) {
    if (step.activityType === 'WRITE_LOG') {
      continue;
    }
    for (const file of step.files) {
      const idKey = file.id.trim();
      if (idKey.length > 0 && seenIds.has(idKey)) {
        continue;
      }
      if (idKey.length > 0) {
        seenIds.add(idKey);
      }
      files.push(file);
    }
  }

  return files;
}

function buildFileWidget(file: ExecutionFileLocator): UiViewWidget {
  const trimmedName = file.name.trim();
  const displayName = trimmedName.length > 0 ? trimmedName : 'Unnamed File';
  const trimmedParentName = file.parentName?.trim();
  const trimmedUri = file.uri?.trim();

  return {
    decoratedText: {
      text: escapeCardHtml(displayName),
      wrapText: true,
      ...(trimmedParentName ? { bottomLabel: trimmedParentName } : {}),
      ...(trimmedUri
        ? {
            button: {
              text: 'Open',
              onClick: {
                openLink: {
                  url: trimmedUri,
                  openAs: 'FULL_SIZE' as const,
                },
              },
            },
          }
        : {}),
    },
  };
}

/**
 * Host-agnostic UiViewSchema adapter for the post-submit Document Success Card.
 */
export class DocumentSuccessCardAdapter implements UiViewSchemaAdapterPort {
  public readonly viewId = DOCUMENT_SUCCESS_CARD_VIEW_ID;
  public readonly contextKeys: readonly string[] = [];
  public readonly requiresDocumentSchema = false;
  public readonly requiresUiSchema = 'optional' as const;

  constructor(
    private readonly displayNameResolver?: DocumentTypeDisplayNameResolverPort
  ) {}

  async composeView(context: UiViewAdapterContext): Promise<UiView> {
    const outcome = context.executionOutcome;
    if (!outcome) {
      throw new Error('executionOutcome is required for document-success-card');
    }

    let resolvedDocTypeName: string | undefined;
    if (context.documentTypeKey && this.displayNameResolver) {
      resolvedDocTypeName = await this.displayNameResolver.getDisplayName(context.documentTypeKey);
    }
    const docTypeDisplayName =
      resolvedDocTypeName?.trim() || context.documentTypeKey?.trim() || 'Document';
    const trimmedSpaceName = outcome.spaceName.trim();

    const header: UiViewHeader = {
      title: `${docTypeDisplayName} Filed`,
      ...(trimmedSpaceName.length > 0 ? { subtitle: trimmedSpaceName } : {}),
    };

    const bannerWidgets: UiViewWidget[] = [];
    const trimmedWorkflowName = outcome.workflowName?.trim();
    const bannerText = trimmedWorkflowName
      ? `Filed via <b>${escapeCardHtml(trimmedWorkflowName)}</b>`
      : 'Filed.';
    bannerWidgets.push({
      textParagraph: {
        text: bannerText,
      },
    });

    const trimmedNotices = outcome.notices
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (trimmedNotices.length > 0) {
      bannerWidgets.push({
        textParagraph: {
          text: `<font color="#b06000"><b>Warnings:</b></font> ${trimmedNotices.map(escapeCardHtml).join('<br>')}`,
        },
      });
    }

    const sections: UiViewSection[] = [{ widgets: bannerWidgets }];

    const filedFiles = collectCreatedAndFiledFiles(outcome.stepResults);
    if (filedFiles.length > 0) {
      sections.push({
        header: 'Created & Filed',
        widgets: filedFiles.map(buildFileWidget),
      });
    }

    sections.push({
      widgets: [
        {
          buttonList: {
            buttons: [
              {
                text: 'Start Over',
                onClick: {
                  action: 'startOver',
                },
              },
            ],
          },
        },
      ],
    });

    return {
      id: this.viewId,
      header,
      sections,
    };
  }
}

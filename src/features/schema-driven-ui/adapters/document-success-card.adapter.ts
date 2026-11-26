import type { UiView, UiViewButton, UiViewHeader, UiViewSection, UiViewWidget } from '../domain';
import type {
  DocumentTypeDisplayNameResolverPort,
  ExecutionFileLocator,
  ExecutionLogWrite,
  UiViewAdapterContext,
  UiViewSchemaAdapterPort,
} from '../ports';
import { escapeCardHtml } from '../blocks/common';

export const DOCUMENT_SUCCESS_CARD_VIEW_ID = 'document-success-card';

function buildOpenLinkButton(text: string, url: string): UiViewButton {
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

const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

interface FolderDisplayEntry {
  id: string;
  name: string;
  isFallbackName: boolean;
  uri?: string | undefined;
}

function isFolderOnlyPlaceholder(file: ExecutionFileLocator): boolean {
  const id = file.id.trim();
  const parentId = file.parentId?.trim();
  return (
    id.length > 0 &&
    parentId !== undefined &&
    id === parentId &&
    (file.mimeType === undefined || file.mimeType === GOOGLE_FOLDER_MIME_TYPE)
  );
}

function collectFolders(
  stepResults: NonNullable<UiViewAdapterContext['executionOutcome']>['stepResults']
): FolderDisplayEntry[] {
  const foldersById = new Map<string, FolderDisplayEntry>();

  for (const step of stepResults) {
    if (step.activityType === 'WRITE_LOG') {
      continue;
    }
    for (const file of step.files) {
      const parentId = file.parentId?.trim();
      if (!parentId) {
        continue;
      }

      const candidateName =
        file.parentName?.trim() ||
        (isFolderOnlyPlaceholder(file) ? file.name.trim() : '');
      const candidateUri =
        file.parentUri?.trim() ||
        (isFolderOnlyPlaceholder(file) ? file.uri?.trim() : '') ||
        undefined;

      const existing = foldersById.get(parentId);
      if (!existing) {
        foldersById.set(parentId, {
          id: parentId,
          name: candidateName || parentId,
          isFallbackName: candidateName.length === 0,
          ...(candidateUri ? { uri: candidateUri } : {}),
        });
      } else {
        if (existing.isFallbackName && candidateName.length > 0) {
          existing.name = candidateName;
          existing.isFallbackName = false;
        }
        if (!existing.uri && candidateUri) {
          existing.uri = candidateUri;
        }
      }
    }
  }

  return Array.from(foldersById.values());
}

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
      if (isFolderOnlyPlaceholder(file)) {
        continue;
      }
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

function buildFolderWidget(folder: FolderDisplayEntry): UiViewWidget {
  const trimmedUri = folder.uri?.trim();
  return {
    decoratedText: {
      text: escapeCardHtml(folder.name),
      wrapText: true,
      ...(trimmedUri ? { button: buildOpenLinkButton('Open', trimmedUri) } : {}),
    },
  };
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
      ...(trimmedUri ? { button: buildOpenLinkButton('Open', trimmedUri) } : {}),
    },
  };
}

function buildFallbackLogSummarySection(logWrite: ExecutionLogWrite): UiViewSection {
  const trimmedSheetName = logWrite.sheetName?.trim();
  const rowNumber =
    typeof logWrite.rowNumber === 'number' && Number.isFinite(logWrite.rowNumber)
      ? logWrite.rowNumber
      : undefined;
  const text =
    trimmedSheetName && trimmedSheetName.length > 0 && rowNumber !== undefined
      ? `<b>${escapeCardHtml(trimmedSheetName)}</b> \u2022 Row ${rowNumber}`
      : 'Document Log Entry';
  const trimmedUri = logWrite.uri?.trim();

  return {
    header: 'Summary',
    widgets: [
      {
        decoratedText: {
          text,
          wrapText: true,
          ...(trimmedUri ? { button: buildOpenLinkButton('Open Log', trimmedUri) } : {}),
        },
      },
    ],
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

    if (outcome.logWrite !== undefined) {
      sections.push(buildFallbackLogSummarySection(outcome.logWrite));
    }

    const folders = collectFolders(outcome.stepResults);
    if (folders.length > 0) {
      sections.push({
        header: 'Folders',
        widgets: folders.map(buildFolderWidget),
      });
    }

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

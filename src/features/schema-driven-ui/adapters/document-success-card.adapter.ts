import type {
  DocumentUiSuccessArtifact,
  DocumentUiSuccessSummary,
  UiView,
  UiViewButton,
  UiViewHeader,
  UiViewSection,
  UiViewWidget,
} from '../domain';
import type {
  DocumentTypeDisplayNameResolverPort,
  ExecutionFileLocator,
  ExecutionLogWrite,
  TemplateParserPort,
  UiViewAdapterContext,
  UiViewSchemaAdapterPort,
} from '../ports';
import { escapeCardHtml } from '../blocks/common';

export const DOCUMENT_SUCCESS_CARD_VIEW_ID = 'document-success-card';
const MAX_GOOGLE_WORKSPACE_CARD_WIDGETS = 100;
const UNCOLLAPSIBLE_ARTIFACT_COUNT = 5;

interface CollectedArtifactItem {
  file: ExecutionFileLocator;
  roleLabel?: string | undefined;
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r?\n|\r/g, ' ');
}

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

function resolveTokenString(
  data: Readonly<Record<string, unknown>>,
  parts: readonly string[]
): string {
  let current: unknown = data;
  for (const part of parts) {
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return '';
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current === 'string') {
    return current;
  }
  if (typeof current === 'number' || typeof current === 'boolean') {
    return String(current);
  }
  return '';
}

function stitchTemplate(
  parser: TemplateParserPort,
  template: string,
  data: Readonly<Record<string, unknown>>,
  options: { escapeHtml: boolean }
): string {
  const parsed = parser.parseMustacheTemplate(template);
  let result = normalizeNewlines(parsed.literals[0] ?? '');
  for (let i = 0; i < parsed.tokens.length; i++) {
    const rawValue = normalizeNewlines(resolveTokenString(data, parsed.tokens[i]!.parts));
    const interpolated = options.escapeHtml ? escapeCardHtml(rawValue) : rawValue;
    const nextLiteral = normalizeNewlines(parsed.literals[i + 1] ?? '');
    result += interpolated + nextLiteral;
  }
  return result.trim();
}

function buildSummarySection(
  summary: DocumentUiSuccessSummary,
  documentData: Readonly<Record<string, unknown>>,
  templateParser?: TemplateParserPort,
  logWrite?: ExecutionLogWrite
): UiViewSection {
  if (!templateParser) {
    throw new Error('TemplateParserPort is required to evaluate successView.summary');
  }

  const stitchedText = stitchTemplate(templateParser, summary.text, documentData, {
    escapeHtml: true,
  });
  const visibleText = stitchedText.replace(/<[^>]*>/g, '').trim();
  const text = visibleText.length > 0 ? stitchedText : '—';

  const topLabel =
    summary.topLabel !== undefined
      ? stitchTemplate(templateParser, summary.topLabel, documentData, { escapeHtml: false })
      : '';
  const bottomLabel =
    summary.bottomLabel !== undefined
      ? stitchTemplate(templateParser, summary.bottomLabel, documentData, { escapeHtml: false })
      : '';
  const trimmedLogUri = logWrite?.uri?.trim();

  return {
    header: 'Summary',
    widgets: [
      {
        decoratedText: {
          ...(topLabel.length > 0 ? { topLabel } : {}),
          text,
          wrapText: true,
          ...(bottomLabel.length > 0 ? { bottomLabel } : {}),
          ...(trimmedLogUri ? { button: buildOpenLinkButton('Open Log', trimmedLogUri) } : {}),
        },
      },
    ],
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

function resolveArtifactLabel(
  spec: DocumentUiSuccessArtifact,
  stepHasNotices: boolean,
  workflowName: string | undefined
): string {
  if (stepHasNotices && spec.fallbackLabel?.trim()) {
    return spec.fallbackLabel.trim();
  }
  if (workflowName && spec.whenWorkflow?.[workflowName]?.trim()) {
    return spec.whenWorkflow[workflowName].trim();
  }
  return spec.label.trim();
}

function collectCreatedAndFiledItems(
  stepResults: NonNullable<UiViewAdapterContext['executionOutcome']>['stepResults'],
  artifactSpecs: readonly DocumentUiSuccessArtifact[] | undefined,
  workflowName: string | undefined
): CollectedArtifactItem[] {
  const seenIds = new Set<string>();
  const items: CollectedArtifactItem[] = [];

  const pushUnique = (file: ExecutionFileLocator, roleLabel?: string) => {
    if (isFolderOnlyPlaceholder(file)) {
      return;
    }
    const idKey = file.id.trim();
    if (idKey.length > 0 && seenIds.has(idKey)) {
      return;
    }
    if (idKey.length > 0) {
      seenIds.add(idKey);
    }
    items.push({
      file,
      ...(roleLabel !== undefined && roleLabel.length > 0 ? { roleLabel } : {}),
    });
  };

  if (artifactSpecs && artifactSpecs.length > 0) {
    for (const spec of artifactSpecs) {
      for (const step of stepResults) {
        if (step.activityType === 'WRITE_LOG' || step.stepId !== spec.stepId) {
          continue;
        }
        const stepHasNotices =
          step.notices?.some((notice) => notice.trim().length > 0) ?? false;
        const roleLabel = resolveArtifactLabel(spec, stepHasNotices, workflowName);
        for (const file of step.files) {
          pushUnique(file, roleLabel);
        }
      }
    }
  }

  for (const step of stepResults) {
    if (step.activityType === 'WRITE_LOG') {
      continue;
    }
    for (const file of step.files) {
      pushUnique(file);
    }
  }

  return items;
}

function allocateSuccessCardBudget(params: {
  fixedWidgetCount: number;
  totalFolders: number;
  totalArtifacts: number;
}): {
  renderedFoldersCount: number;
  renderedArtifactsCount: number;
  hasOverflow: boolean;
} {
  const { fixedWidgetCount, totalFolders, totalArtifacts } = params;
  const remainingBudget = Math.max(0, MAX_GOOGLE_WORKSPACE_CARD_WIDGETS - fixedWidgetCount);

  if (totalFolders + totalArtifacts <= remainingBudget) {
    return {
      renderedFoldersCount: totalFolders,
      renderedArtifactsCount: totalArtifacts,
      hasOverflow: false,
    };
  }

  if (remainingBudget === 0) {
    return {
      renderedFoldersCount: 0,
      renderedArtifactsCount: 0,
      hasOverflow: false,
    };
  }

  const itemBudget = Math.max(0, remainingBudget - 1);
  const reservedForArtifacts = Math.min(totalArtifacts, Math.ceil(itemBudget / 2));
  const renderedFoldersCount = Math.min(
    totalFolders,
    Math.max(0, itemBudget - reservedForArtifacts)
  );
  const renderedArtifactsCount = Math.min(
    totalArtifacts,
    Math.max(0, itemBudget - renderedFoldersCount)
  );

  return {
    renderedFoldersCount,
    renderedArtifactsCount,
    hasOverflow: true,
  };
}

function buildOverflowNoticeSection(params: {
  renderedFoldersCount: number;
  totalFolders: number;
  renderedArtifactsCount: number;
  totalArtifacts: number;
  primaryFolderUri: string | undefined;
}): UiViewSection {
  const {
    renderedFoldersCount,
    totalFolders,
    renderedArtifactsCount,
    totalArtifacts,
    primaryFolderUri,
  } = params;
  const foldersTruncated = renderedFoldersCount < totalFolders;
  const artifactsTruncated = renderedArtifactsCount < totalArtifacts;

  let text: string;
  if (foldersTruncated && artifactsTruncated) {
    text = `Showing ${renderedFoldersCount} of ${totalFolders} folders and ${renderedArtifactsCount} of ${totalArtifacts} filed items`;
  } else if (artifactsTruncated) {
    text = `Showing ${renderedArtifactsCount} of ${totalArtifacts} filed items`;
  } else {
    text = `Showing ${renderedFoldersCount} of ${totalFolders} folders`;
  }

  const trimmedFolderUri = primaryFolderUri?.trim();
  return {
    widgets: [
      {
        decoratedText: {
          text,
          wrapText: true,
          ...(trimmedFolderUri
            ? { button: buildOpenLinkButton('Open Folder', trimmedFolderUri) }
            : {}),
        },
      },
    ],
  };
}

function buildFileWidget(item: CollectedArtifactItem): UiViewWidget {
  const { file, roleLabel } = item;
  const trimmedName = file.name.trim();
  const displayName = trimmedName.length > 0 ? trimmedName : 'Unnamed File';
  const trimmedParentName = file.parentName?.trim();
  const trimmedUri = file.uri?.trim();

  return {
    decoratedText: {
      ...(roleLabel ? { topLabel: roleLabel } : {}),
      text: escapeCardHtml(displayName),
      wrapText: true,
      ...(trimmedParentName ? { bottomLabel: trimmedParentName } : {}),
      ...(trimmedUri ? { button: buildOpenLinkButton('Open', trimmedUri) } : {}),
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
    private readonly displayNameResolver?: DocumentTypeDisplayNameResolverPort,
    private readonly templateParser?: TemplateParserPort
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
    const trimmedNotices = outcome.notices
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const status: 'partial_failure' | 'warning' | 'success' = !outcome.success
      ? 'partial_failure'
      : trimmedNotices.length > 0
        ? 'warning'
        : 'success';

    const headerTitle =
      status === 'partial_failure'
        ? `${docTypeDisplayName} \u2014 Partial Failure`
        : status === 'warning'
          ? `${docTypeDisplayName} Filed (with Warnings)`
          : `${docTypeDisplayName} Filed`;

    const header: UiViewHeader = {
      title: headerTitle,
      ...(trimmedSpaceName.length > 0 ? { subtitle: trimmedSpaceName } : {}),
    };

    const bannerWidgets: UiViewWidget[] = [];
    const trimmedWorkflowName = outcome.workflowName?.trim() || undefined;
    if (status === 'partial_failure') {
      const failedStepId = outcome.failedStepId?.trim();
      const trimmedErrors = outcome.errors
        .map((e) => e.trim())
        .filter((e) => e.length > 0);
      const errorMessage =
        trimmedErrors.length > 0
          ? trimmedErrors.map(escapeCardHtml).join('<br>')
          : 'Workflow failed partway through.';
      const stepNoun = outcome.completedStepCount === 1 ? 'step' : 'steps';
      const failedPrefix = failedStepId
        ? `Failed at ${escapeCardHtml(failedStepId)}:`
        : 'Partial failure:';
      bannerWidgets.push({
        textParagraph: {
          text: `<font color="#c5221f"><b>${failedPrefix}</b></font> ${errorMessage}<br><i>${outcome.completedStepCount} completed ${stepNoun} before failure.</i>`,
        },
      });
    } else {
      const bannerText = trimmedWorkflowName
        ? `Filed via <b>${escapeCardHtml(trimmedWorkflowName)}</b>`
        : 'Filed.';
      bannerWidgets.push({
        textParagraph: {
          text: bannerText,
        },
      });
    }

    if (trimmedNotices.length > 0) {
      bannerWidgets.push({
        textParagraph: {
          text: `<font color="#b06000"><b>Warnings:</b></font> ${trimmedNotices.map(escapeCardHtml).join('<br>')}`,
        },
      });
    }

    const bannerSection: UiViewSection = { widgets: bannerWidgets };
    const successView = context.uiSchema?.successView;
    const summarySection: UiViewSection | undefined = successView?.summary
      ? buildSummarySection(
          successView.summary,
          outcome.documentData,
          this.templateParser,
          outcome.logWrite
        )
      : outcome.logWrite !== undefined
        ? buildFallbackLogSummarySection(outcome.logWrite)
        : undefined;

    const actionsSection: UiViewSection = {
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
    };

    const fixedWidgetCount =
      bannerSection.widgets.length +
      (summarySection?.widgets.length ?? 0) +
      actionsSection.widgets.length;

    const folders = collectFolders(outcome.stepResults);
    const filedItems = collectCreatedAndFiledItems(
      outcome.stepResults,
      successView?.artifacts,
      trimmedWorkflowName
    );

    const budget = allocateSuccessCardBudget({
      fixedWidgetCount,
      totalFolders: folders.length,
      totalArtifacts: filedItems.length,
    });

    const sections: UiViewSection[] = [bannerSection];
    if (summarySection) {
      sections.push(summarySection);
    }

    const renderedFolders = folders.slice(0, budget.renderedFoldersCount);
    if (renderedFolders.length > 0) {
      sections.push({
        header: 'Folders',
        widgets: renderedFolders.map(buildFolderWidget),
      });
    }

    const renderedArtifacts = filedItems.slice(0, budget.renderedArtifactsCount);
    if (renderedArtifacts.length > 0) {
      sections.push({
        header: 'Created & Filed',
        widgets: renderedArtifacts.map(buildFileWidget),
        ...(renderedArtifacts.length > UNCOLLAPSIBLE_ARTIFACT_COUNT
          ? {
              collapsible: true,
              uncollapsibleWidgetsCount: UNCOLLAPSIBLE_ARTIFACT_COUNT,
            }
          : {}),
      });
    }

    if (budget.hasOverflow) {
      sections.push(
        buildOverflowNoticeSection({
          renderedFoldersCount: renderedFolders.length,
          totalFolders: folders.length,
          renderedArtifactsCount: renderedArtifacts.length,
          totalArtifacts: filedItems.length,
          primaryFolderUri: folders[0]?.uri,
        })
      );
    }

    sections.push(actionsSection);

    return {
      id: this.viewId,
      header,
      sections,
    };
  }
}

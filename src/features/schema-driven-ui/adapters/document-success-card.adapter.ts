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

    const header: UiViewHeader = {
      title: `${docTypeDisplayName} Filed`,
      ...(trimmedSpaceName.length > 0 ? { subtitle: trimmedSpaceName } : {}),
    };

    const bannerWidgets: UiViewWidget[] = [];
    const trimmedWorkflowName = outcome.workflowName?.trim() || undefined;
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

    const successView = context.uiSchema?.successView;
    if (successView?.summary) {
      sections.push(
        buildSummarySection(
          successView.summary,
          outcome.documentData,
          this.templateParser,
          outcome.logWrite
        )
      );
    } else if (outcome.logWrite !== undefined) {
      sections.push(buildFallbackLogSummarySection(outcome.logWrite));
    }

    const filedItems = collectCreatedAndFiledItems(
      outcome.stepResults,
      successView?.artifacts,
      trimmedWorkflowName
    );
    if (filedItems.length > 0) {
      sections.push({
        header: 'Created & Filed',
        widgets: filedItems.map(buildFileWidget),
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

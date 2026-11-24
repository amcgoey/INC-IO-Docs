import { Value } from '@sinclair/typebox/value';
import {
  DOCUMENT_LOG_CONTEXT_KEY,
  DocumentLogPanelContextSchema,
  type DocumentLogPanelContext,
  type UiViewSchemaAdapterPort,
  type UiViewAdapterContext,
  type DocumentTypeDisplayNameResolverPort,
} from '../ports';
import type { UiView, UiViewSection } from '../domain';
import {
  buildStatusMessageSection,
  buildDocumentTypeSelectionSection,
  buildFileSelectionSection,
  buildDocumentLogSection,
  buildDocumentInfoSection,
  buildDocumentAdminSection,
} from '../blocks';

export const WORKSPACE_ADDON_VIEW_ID = 'drive-document-process-card';
export const GMAIL_WORKSPACE_ADDON_VIEW_ID = 'gmail-document-process-card';
const MAX_GOOGLE_WORKSPACE_CARD_WIDGETS = 100;

export type SectionProducer = (context: UiViewAdapterContext) => UiViewSection | undefined;

export interface WorkspaceAddonViewSchemaConfig {
  viewId: string;
  fileSelectionConfig?: (context: UiViewAdapterContext) => UiViewSection | undefined;
  getActionParameters?: (context: UiViewAdapterContext) => Record<string, unknown> | undefined;
}

export type WorkspaceAddonViewComposer = (
  context: UiViewAdapterContext,
  displayNameResolver?: DocumentTypeDisplayNameResolverPort
) => Promise<UiView> | UiView;

function extractDocumentLogPanelContext(
  uiContext: Record<string, unknown> | undefined
): DocumentLogPanelContext | undefined {
  const raw = uiContext?.[DOCUMENT_LOG_CONTEXT_KEY];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Value.Check(DocumentLogPanelContextSchema, raw)) {
    const details = [...Value.Errors(DocumentLogPanelContextSchema, raw)]
      .map((e) => `${e.path}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid uiContext["${DOCUMENT_LOG_CONTEXT_KEY}"]: ${details}`);
  }
  return raw;
}

function buildViewFromSections(
  viewId: string,
  fixedProducers: {
    status: SectionProducer;
    docType: SectionProducer;
    fileSelection: SectionProducer;
    docInfo: (ctx: UiViewAdapterContext, processDisabled: boolean) => UiViewSection | undefined;
    admin: SectionProducer;
  },
  context: UiViewAdapterContext,
  getActionParameters?: ((context: UiViewAdapterContext) => Record<string, unknown> | undefined) | undefined
): UiView {
  const logContext = extractDocumentLogPanelContext(context.uiContext);
  const processDisabled =
    logContext?.status === 'missing' || logContext?.status === 'missing_space';

  const statusSection = fixedProducers.status(context);
  const docTypeSection = fixedProducers.docType(context);
  const fileSection = fixedProducers.fileSelection(context);
  const docInfoSection = fixedProducers.docInfo(context, processDisabled);
  const adminSection = fixedProducers.admin(context);

  const fixedWidgetCount =
    (statusSection?.widgets.length ?? 0) +
    (docTypeSection?.widgets.length ?? 0) +
    (fileSection?.widgets.length ?? 0) +
    (docInfoSection?.widgets.length ?? 0) +
    (adminSection?.widgets.length ?? 0);

  const actionParams = getActionParameters ? getActionParameters(context) : undefined;
  const documentLogSection = buildDocumentLogSection(logContext, {
    maxWidgets: MAX_GOOGLE_WORKSPACE_CARD_WIDGETS - fixedWidgetCount,
    ...(actionParams && Object.keys(actionParams).length > 0
      ? { actionParameters: actionParams }
      : {}),
  });

  const sections: UiViewSection[] = [
    statusSection,
    docTypeSection,
    fileSection,
    documentLogSection,
    docInfoSection,
    adminSection,
  ].filter((section): section is UiViewSection => section !== undefined);

  return {
    id: viewId,
    header: {
      title: 'INC-IO Engine',
      subtitle: 'Process Document',
    },
    sections,
    ...(context.uiSchema?.evaluationOrder
      ? { evaluationOrder: context.uiSchema.evaluationOrder }
      : {}),
  };
}

async function resolveAndBuildView(
  viewId: string,
  fixedProducers: {
    status: SectionProducer;
    docType: SectionProducer;
    fileSelection: SectionProducer;
    docInfo: (ctx: UiViewAdapterContext, processDisabled: boolean) => UiViewSection | undefined;
    admin: SectionProducer;
  },
  context: UiViewAdapterContext,
  displayNameResolver: DocumentTypeDisplayNameResolverPort,
  getActionParameters?: ((context: UiViewAdapterContext) => Record<string, unknown> | undefined) | undefined
): Promise<UiView> {
  const resolvedDocTypes = await Promise.all(
    context.selectionState!.documentTypes.map(async (docType) => {
      const displayName = await displayNameResolver.getDisplayName(docType.value);
      return {
        ...docType,
        text: displayName ?? docType.text,
      };
    })
  );

  const effectiveContext: UiViewAdapterContext = {
    ...context,
    selectionState: {
      ...context.selectionState!,
      documentTypes: resolvedDocTypes,
    },
  };

  return buildViewFromSections(viewId, fixedProducers, effectiveContext, getActionParameters);
}

export function createWorkspaceAddonViewSchema(
  config: WorkspaceAddonViewSchemaConfig
): WorkspaceAddonViewComposer;
export function createWorkspaceAddonViewSchema(
  config: WorkspaceAddonViewSchemaConfig,
  context: UiViewAdapterContext,
  displayNameResolver?: DocumentTypeDisplayNameResolverPort
): Promise<UiView> | UiView;
export function createWorkspaceAddonViewSchema(
  config: WorkspaceAddonViewSchemaConfig,
  context?: UiViewAdapterContext,
  displayNameResolver?: DocumentTypeDisplayNameResolverPort
): WorkspaceAddonViewComposer | Promise<UiView> | UiView {
  const fileSelectionProducer: SectionProducer =
    config.fileSelectionConfig ??
    ((ctx) =>
      ctx.selectionState
        ? buildFileSelectionSection(ctx.selectionState, { formData: ctx.formData })
        : undefined);

  const fixedProducers = {
    // 1. Status Section (status messages & validation errors)
    status: (ctx: UiViewAdapterContext) =>
      ctx.statusMessages?.length || ctx.validationErrors?.length
        ? buildStatusMessageSection({
            statusMessages: ctx.statusMessages,
            validationErrors: ctx.validationErrors,
          })
        : undefined,

    // 2. Document Type Selection Section
    docType: (ctx: UiViewAdapterContext) => {
      if (!ctx.selectionState) {
        return undefined;
      }
      const actionParams = config.getActionParameters ? config.getActionParameters(ctx) : undefined;
      return buildDocumentTypeSelectionSection(ctx.selectionState, {
        onSpaceTypeChangeAction: {
          action: 'onSpaceTypeChange',
          ...(actionParams ? { parameters: actionParams } : {}),
        },
        onSpaceChangeAction: {
          action: 'onFormChange',
          ...(actionParams ? { parameters: actionParams } : {}),
        },
        onDocumentTypeChangeAction: {
          action: 'onDocumentTypeChange',
          ...(actionParams ? { parameters: actionParams } : {}),
        },
        formData: ctx.formData,
      });
    },

    // 3. File Selection Section
    fileSelection: fileSelectionProducer,

    // 4. Document Info Section (Document Log sits directly before this)
    docInfo: (ctx: UiViewAdapterContext, processDisabled: boolean) => {
      if (!ctx.documentSchema) {
        return undefined;
      }
      const actionParams = config.getActionParameters ? config.getActionParameters(ctx) : undefined;
      return buildDocumentInfoSection(ctx.documentSchema, ctx.uiSchema, {
        sectionHeader: 'Document Data',
        formData: ctx.formData,
        hiddenFields: ctx.hiddenFields,
        documentTypeKey: ctx.documentTypeKey,
        dynamicOptions: ctx.dynamicOptions,
        ...(actionParams ? { onChangeActionParameters: actionParams } : {}),
        ...(ctx.documentTypeKey ? { onProcessAction: { action: 'processDocument' } } : {}),
        ...(processDisabled ? { processDisabled: true } : {}),
      });
    },

    // 5. Admin Section (always present)
    admin: () => buildDocumentAdminSection(),
  };

  const compose: WorkspaceAddonViewComposer = (
    ctx: UiViewAdapterContext,
    resolver?: DocumentTypeDisplayNameResolverPort
  ): Promise<UiView> | UiView => {
    if (!resolver || !ctx.selectionState?.documentTypes) {
      return buildViewFromSections(
        config.viewId,
        fixedProducers,
        ctx,
        config.getActionParameters
      );
    }
    return resolveAndBuildView(
      config.viewId,
      fixedProducers,
      ctx,
      resolver,
      config.getActionParameters
    );
  };

  if (context !== undefined) {
    return compose(context, displayNameResolver);
  }

  return compose;
}

export class WorkspaceAddonAdapter implements UiViewSchemaAdapterPort {
  public readonly viewId = WORKSPACE_ADDON_VIEW_ID;
  public readonly contextKeys = [DOCUMENT_LOG_CONTEXT_KEY] as const;
  private readonly composer: WorkspaceAddonViewComposer;

  constructor(
    private readonly displayNameResolver?: DocumentTypeDisplayNameResolverPort
  ) {
    this.composer = createWorkspaceAddonViewSchema({
      viewId: this.viewId,
      fileSelectionConfig: (context) =>
        context.selectionState
          ? buildFileSelectionSection(context.selectionState, {
              collapsible: true,
              inputName: 'SelectFiles',
              emptyText: 'No files selected.',
              formData: context.formData,
            })
          : undefined,
    });
  }

  composeView(context: UiViewAdapterContext): Promise<UiView> | UiView {
    return this.composer(context, this.displayNameResolver);
  }
}

export function extractGmailActionParameters(ctx: UiViewAdapterContext): Record<string, string> {
  const rawAttachmentForm = ctx.formData?.['SelectAttachments'];
  let checkedAttachmentIds: string[];
  if (rawAttachmentForm !== undefined) {
    if (Array.isArray(rawAttachmentForm)) {
      checkedAttachmentIds = rawAttachmentForm.map(String);
    } else if (typeof rawAttachmentForm === 'string') {
      checkedAttachmentIds =
        rawAttachmentForm.trim().length > 0 ? [rawAttachmentForm.trim()] : [];
    } else {
      checkedAttachmentIds = [];
    }
  } else {
    checkedAttachmentIds =
      ctx.selectionState?.files?.filter((f) => f.selected).map((f) => f.value) ?? [];
  }

  const currentDriveUrl = (ctx.formData?.['InputDriveURL'] as string) ?? '';
  const selectedThreadMsg = ctx.selectionState?.threadMessages?.find((m) => m.selected)?.value;
  const previousMessageId = (ctx.formData?.['SelectEmailMessage'] as string) ?? selectedThreadMsg;

  return {
    previousAttachments: JSON.stringify(checkedAttachmentIds),
    previousDriveUrl: currentDriveUrl,
    ...(previousMessageId !== undefined && previousMessageId.trim().length > 0
      ? { previousMessageId: previousMessageId.trim() }
      : {}),
  };
}

export class GmailWorkspaceAddonAdapter implements UiViewSchemaAdapterPort {
  public readonly viewId = GMAIL_WORKSPACE_ADDON_VIEW_ID;
  public readonly contextKeys = [DOCUMENT_LOG_CONTEXT_KEY] as const;
  private readonly composer: WorkspaceAddonViewComposer;

  constructor(
    private readonly displayNameResolver?: DocumentTypeDisplayNameResolverPort
  ) {
    this.composer = createWorkspaceAddonViewSchema({
      viewId: this.viewId,
      getActionParameters: (ctx) => extractGmailActionParameters(ctx),
      fileSelectionConfig: (ctx) => {
        if (!ctx.selectionState) {
          return undefined;
        }

        const actionParams = extractGmailActionParameters(ctx);

        return buildFileSelectionSection(ctx.selectionState, {
          collapsible: false,
          inputName: 'SelectAttachments',
          emptyText: 'No attachments found.',
          formData: ctx.formData,
          itemDropdown: {
            name: 'SelectEmailMessage',
            label: 'Email',
            items: ctx.selectionState.threadMessages,
            onChangeAction: {
              action: 'onEmailMessageChange',
              parameters: actionParams,
            },
          },
          fileSourceDropdown: {
            name: 'SelectFileSource',
            label: 'File Source',
            onChangeAction: {
              action: 'onFileSourceChange',
              parameters: actionParams,
            },
          },
          urlInput: {
            name: 'InputDriveURL',
            label: 'Google Drive URL',
            hintText: 'Enter Google Drive file or folder URL',
            activeOnSourceValue: 'Google Drive URL',
            onChangeAction: {
              action: 'onFormChange',
              parameters: actionParams,
            },
          },
          toggleInput: {
            name: 'SaveEmailToPdf',
            text: 'Save Email to PDF',
            value: 'true',
          },
        });
      },
    });
  }

  composeView(context: UiViewAdapterContext): Promise<UiView> | UiView {
    return this.composer(context, this.displayNameResolver);
  }
}


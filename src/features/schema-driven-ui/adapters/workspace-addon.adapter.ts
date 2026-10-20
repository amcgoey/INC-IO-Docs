import type {
  UiViewSchemaAdapterPort,
  UiViewAdapterContext,
  DocumentTypeDisplayNameResolverPort,
} from '../ports';
import type { UiView, UiViewSection } from '../domain';
import {
  buildStatusMessageSection,
  buildDocumentTypeSelectionSection,
  buildFileSelectionSection,
  buildDocumentInfoSection,
  buildDocumentAdminSection,
} from '../blocks';

export const WORKSPACE_ADDON_VIEW_ID = 'drive-document-process-card';
export const GMAIL_WORKSPACE_ADDON_VIEW_ID = 'gmail-document-process-card';

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

function buildViewFromSections(
  viewId: string,
  sectionsProducers: readonly SectionProducer[],
  context: UiViewAdapterContext
): UiView {
  const sections: UiViewSection[] = [];
  for (const produceSection of sectionsProducers) {
    const section = produceSection(context);
    if (section) {
      sections.push(section);
    }
  }

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
  sectionsProducers: readonly SectionProducer[],
  context: UiViewAdapterContext,
  displayNameResolver: DocumentTypeDisplayNameResolverPort
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

  return buildViewFromSections(viewId, sectionsProducers, effectiveContext);
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

  const schema: readonly SectionProducer[] = [
    // 1. Status Section (status messages & validation errors)
    (ctx) =>
      (ctx.statusMessages?.length || ctx.validationErrors?.length)
        ? buildStatusMessageSection({
            statusMessages: ctx.statusMessages,
            validationErrors: ctx.validationErrors,
          })
        : undefined,

    // 2. Document Type Selection Section
    (ctx) => {
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
    fileSelectionProducer,

    // 4. Document Info Section
    (ctx) => {
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
      });
    },

    // 5. Admin Section (always present)
    () => buildDocumentAdminSection(),
  ];

  const compose: WorkspaceAddonViewComposer = (
    ctx: UiViewAdapterContext,
    resolver?: DocumentTypeDisplayNameResolverPort
  ): Promise<UiView> | UiView => {
    if (!resolver || !ctx.selectionState?.documentTypes) {
      return buildViewFromSections(config.viewId, schema, ctx);
    }
    return resolveAndBuildView(config.viewId, schema, ctx, resolver);
  };

  if (context !== undefined) {
    return compose(context, displayNameResolver);
  }

  return compose;
}

export class WorkspaceAddonAdapter implements UiViewSchemaAdapterPort {
  public readonly viewId = WORKSPACE_ADDON_VIEW_ID;
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


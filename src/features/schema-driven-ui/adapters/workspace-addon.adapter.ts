import type {
  UiViewSchemaAdapterPort,
  UiViewAdapterContext,
  DocumentTypeDisplayNameResolverPort,
} from '../ports';
import type { UiView, UiViewSection } from '../domain';
import {
  buildStatusMessageSection,
  buildDocumentTypeSelectionSection,
  buildDocumentInfoSection,
  buildDocumentAdminSection,
} from '../blocks';

export const WORKSPACE_ADDON_VIEW_ID = 'drive-document-process-card';

type SectionProducer = (context: UiViewAdapterContext) => UiViewSection | undefined;

/**
 * Declarative UiViewSchema defining the sequence and inclusion rules for UiBlocks
 * in the Workspace Addon process view.
 */
const WORKSPACE_ADDON_VIEW_SCHEMA: readonly SectionProducer[] = [
  // 1. Status Section (validation errors)
  (context) =>
    context.validationErrors
      ? buildStatusMessageSection({ validationErrors: context.validationErrors })
      : undefined,

  // 2. Document Type Selection Section
  (context) =>
    context.selectionState
      ? buildDocumentTypeSelectionSection(context.selectionState, {
          onSpaceTypeChangeAction: { action: '/workspace/action', parameters: { action: 'onSpaceTypeChange' } },
          onDocumentTypeChangeAction: { action: '/workspace/action', parameters: { action: 'onDocumentTypeChange' } },
        })
      : undefined,

  // 3. Document Info Section
  (context) =>
    context.documentSchema
      ? buildDocumentInfoSection(context.documentSchema, context.uiSchema, {
          sectionHeader: 'Document Data',
          formData: context.formData,
          hiddenFields: context.hiddenFields,
          ...(context.documentTypeKey ? { onProcessAction: { action: '/workspace/action', parameters: { action: 'processDocument' } } } : {}),
        })
      : undefined,

  // 4. Admin Section (always present)
  () => buildDocumentAdminSection(),
];

export class WorkspaceAddonAdapter implements UiViewSchemaAdapterPort {
  public readonly viewId = WORKSPACE_ADDON_VIEW_ID;

  constructor(
    private readonly displayNameResolver?: DocumentTypeDisplayNameResolverPort
  ) {}

  composeView(context: UiViewAdapterContext): Promise<UiView> | UiView {
    if (!this.displayNameResolver || !context.selectionState?.documentTypes) {
      const sections: UiViewSection[] = [];
      for (const produceSection of WORKSPACE_ADDON_VIEW_SCHEMA) {
        const section = produceSection(context);
        if (section) {
          sections.push(section);
        }
      }

      return {
        id: this.viewId,
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

    return (async () => {
      const resolvedDocTypes = await Promise.all(
        context.selectionState!.documentTypes.map(async (docType) => {
          const displayName = await this.displayNameResolver!.getDisplayName(docType.value);
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

      const sections: UiViewSection[] = [];
      for (const produceSection of WORKSPACE_ADDON_VIEW_SCHEMA) {
        const section = produceSection(effectiveContext);
        if (section) {
          sections.push(section);
        }
      }

      return {
        id: this.viewId,
        header: {
          title: 'INC-IO Engine',
          subtitle: 'Process Document',
        },
        sections,
        ...(effectiveContext.uiSchema?.evaluationOrder
          ? { evaluationOrder: effectiveContext.uiSchema.evaluationOrder }
          : {}),
      };
    })();
  }
}

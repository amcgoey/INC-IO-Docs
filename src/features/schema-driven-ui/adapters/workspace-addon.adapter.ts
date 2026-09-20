import type { UiViewSchemaAdapterPort, UiViewAdapterContext } from '../ports';
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
    context.validationErrors && context.validationErrors.length > 0
      ? buildStatusMessageSection({ validationErrors: context.validationErrors })
      : undefined,

  // 2. Document Type Selection Section
  (context) =>
    context.selectionState
      ? buildDocumentTypeSelectionSection(context.selectionState, {
          onSpaceTypeChangeAction: { action: 'onSpaceTypeChange' },
          onDocumentTypeChangeAction: { action: 'onDocumentTypeChange' },
        })
      : undefined,

  // 3. Document Info Section
  (context) =>
    context.documentSchema
      ? buildDocumentInfoSection(context.documentSchema, context.uiSchema, {
          sectionHeader: 'Document Data',
        })
      : undefined,

  // 4. Admin Section (always present)
  () => buildDocumentAdminSection(),
];

export class WorkspaceAddonAdapter implements UiViewSchemaAdapterPort {
  public readonly viewId = WORKSPACE_ADDON_VIEW_ID;

  composeView(context: UiViewAdapterContext): UiView {
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
}

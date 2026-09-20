import type { UiViewSchemaAdapterPort, UiViewAdapterContext } from '../ports';
import type { UiView, UiViewSection } from '../domain';
import {
  buildStatusMessageSection,
  buildDocumentTypeSelectionSection,
  buildDocumentInfoSection,
  buildDocumentAdminSection,
} from '../blocks';

export const WORKSPACE_ADDON_VIEW_ID = 'drive-document-process-card';

export class WorkspaceAddonAdapter implements UiViewSchemaAdapterPort {
  public readonly viewId = WORKSPACE_ADDON_VIEW_ID;

  composeView(context: UiViewAdapterContext): UiView {
    const sections: UiViewSection[] = [];

    // 1. Status Section (validation errors if present)
    if (context.validationErrors && context.validationErrors.length > 0) {
      const statusSection = buildStatusMessageSection({
        validationErrors: context.validationErrors,
      });
      if (statusSection) {
        sections.push(statusSection);
      }
    }

    // 2. Document Type Selection Section (if selectionState is present)
    if (context.selectionState) {
      const selectionSection = buildDocumentTypeSelectionSection(context.selectionState, {
        onSpaceTypeChangeAction: { action: 'onSpaceTypeChange' },
        onDocumentTypeChangeAction: { action: 'onDocumentTypeChange' },
      });
      sections.push(selectionSection);
    }

    // 3. Document Info Section (if documentSchema is present)
    if (context.documentSchema) {
      const infoSection = buildDocumentInfoSection(
        context.documentSchema,
        context.uiSchema,
        { sectionHeader: 'Document Data' }
      );
      sections.push(infoSection);
    }

    // 4. Admin Section (always present in process card layout)
    sections.push(buildDocumentAdminSection());

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

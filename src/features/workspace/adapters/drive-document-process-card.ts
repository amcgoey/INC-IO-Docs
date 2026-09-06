import type { WorkspaceDriveSelectedItem } from '../domain';
import type { WorkspaceConfiguration } from '../ports';
import type { UiActionResponse, WorkspaceUiBuilderPort } from './ui-builder';

export function buildDriveDocumentProcessCard(
  selectedItems: WorkspaceDriveSelectedItem[] | undefined,
  config: WorkspaceConfiguration | undefined,
  uiBuilder: WorkspaceUiBuilderPort,
  options?: {
    spaceTypes?: { text: string; value: string; selected?: boolean }[];
    spaces?: string[];
    documentTypes?: { text: string; value: string; selected?: boolean }[];
    statusMessage?: string;
  }
): UiActionResponse {
  const header = uiBuilder.buildTitleBlock({
    title: config?.appTitle ?? 'INC-IO Engine',
    subtitle: 'Process Document',
  });

  const spaceTypes = options?.spaceTypes ?? [];
  const spaces = options?.spaces ?? [];
  const documentTypes = options?.documentTypes ?? [];
  const onSpaceTypeChangeAction = 'https://example.com/onSpaceTypeChange'; // Stub for now

  // Allow optional status message from options or config if provided
  let statusMessage = options?.statusMessage;
  if (statusMessage === undefined) {
    statusMessage = config?.defaultDocumentType
      ? `Current DocumentType: ${config.defaultDocumentType}`
      : 'Processing selected items...';
  }
  const statusSection = uiBuilder.buildStatusMessageBlock(statusMessage, false);

  const documentTypeSection = uiBuilder.buildDocumentTypeSelectionBlock({
    spaceTypes,
    onSpaceTypeChangeAction,
    spaces,
    documentTypes,
  });

  const sections = [];
  if (statusSection) {
    sections.push(statusSection);
  }
  sections.push(documentTypeSection);

  const card = uiBuilder.buildCard(header, sections);

  return uiBuilder.buildNavigationAction(card);
}

import type { WorkspaceDriveSelectedItem } from '../domain';
import type { WorkspaceConfiguration } from '../ports';
import type {
  DocumentSelectionState,
  UiActionResponse,
  WorkspaceUiBuilderPort,
} from './ui-builder';

export interface DriveDocumentProcessCardOptions {
  selectionContext?: DocumentSelectionState;
  statusMessage?: string;
}

export function buildDriveDocumentProcessCard(
  selectedItems: WorkspaceDriveSelectedItem[] | undefined,
  config: WorkspaceConfiguration | undefined,
  uiBuilder: WorkspaceUiBuilderPort,
  options?: DriveDocumentProcessCardOptions
): UiActionResponse {
  const header = uiBuilder.buildTitleBlock({
    title: config?.appTitle ?? 'INC-IO Engine',
    subtitle: 'Process Document',
  });

  const selectionContext: DocumentSelectionState = options?.selectionContext ?? {
    spaceTypes: [],
    spaces: [],
    documentTypes: [],
  };
  const onSpaceTypeChangeAction = 'https://example.com/onSpaceTypeChange'; // Stub for now

  const statusSection = uiBuilder.buildStatusMessageBlock(options?.statusMessage, false);

  const documentTypeSection = uiBuilder.buildDocumentTypeSelectionBlock({
    selectionContext,
    onSpaceTypeChangeAction,
  });

  const sections = [];
  if (statusSection) {
    sections.push(statusSection);
  }
  sections.push(documentTypeSection);

  const card = uiBuilder.buildCard(header, sections);

  return uiBuilder.buildNavigationAction(card);
}

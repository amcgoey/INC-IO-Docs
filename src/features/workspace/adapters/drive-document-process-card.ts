import type { WorkspaceDriveSelectedItem } from '../domain';
import type { WorkspaceConfiguration } from '../ports';
import type { WorkspaceUiBuilderPort } from './ui-builder';
import type { CardActionResponse } from '../../../infrastructure/workspace-addon/ui-blocks';

export function buildDriveDocumentProcessCard(
  selectedItems: WorkspaceDriveSelectedItem[] | undefined,
  config: WorkspaceConfiguration | undefined,
  uiBuilder: WorkspaceUiBuilderPort
): CardActionResponse {
  // Use the default document type from config as a stub status message for manual testing.
  // TODO: Remove this stub message once other functional Blocks are added to the card.
  const stubMessage = config?.defaultDocumentType 
    ? `Current DocumentType: ${config.defaultDocumentType}`
    : 'Processing selected items...';

  const header = uiBuilder.buildTitleBlock({
    title: config?.appTitle ?? 'INC-IO Engine',
    subtitle: 'Process Document',
  });

  const statusSection = uiBuilder.buildStatusMessageBlock(stubMessage, true);

  const card = uiBuilder.buildCard(header, [statusSection]);

  return uiBuilder.buildNavigationAction(card);
}

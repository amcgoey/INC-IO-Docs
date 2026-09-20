import type { UiViewSection } from '../domain';

export interface DocumentAdminOptions {
  header?: string;
  onProcessAction?: unknown;
}

export function buildDocumentAdminSection(options?: DocumentAdminOptions): UiViewSection {
  const buttons = [];
  if (options?.onProcessAction !== undefined) {
    buttons.push({
      text: 'Process Document',
      onClick: { action: options.onProcessAction },
    });
  }
  buttons.push(
    { text: 'Refresh Document', onClick: { action: 'refresh' } },
    { text: 'View Raw JSON', onClick: { action: 'viewJson' } }
  );

  return {
    header: options?.header ?? 'Admin',
    collapsible: true,
    widgets: [
      {
        buttonList: {
          buttons,
        },
      },
    ],
  };
}

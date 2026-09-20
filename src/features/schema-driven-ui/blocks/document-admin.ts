import type { UiViewSection } from '../domain';

export interface DocumentAdminOptions {
  header?: string | undefined;
}

export function buildDocumentAdminSection(options?: DocumentAdminOptions): UiViewSection {
  const buttons = [
    { text: 'Refresh Document', onClick: { action: 'refresh' } },
    { text: 'View Raw JSON', onClick: { action: 'viewJson' } },
  ];

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

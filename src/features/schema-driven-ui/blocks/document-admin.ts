import type { UiViewSection } from '../domain';

export interface DocumentAdminOptions {
  header?: string;
}

export function buildDocumentAdminSection(options?: DocumentAdminOptions): UiViewSection {
  return {
    header: options?.header ?? 'Admin',
    collapsible: true,
    widgets: [
      {
        buttonList: {
          buttons: [
            { text: 'Refresh Document', onClick: { action: 'refresh' } },
            { text: 'View Raw JSON', onClick: { action: 'viewJson' } },
          ],
        },
      },
    ],
  };
}

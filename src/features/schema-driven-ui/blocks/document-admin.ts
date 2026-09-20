import type { UiViewSection, UiViewAction } from '../domain';

export interface DocumentAdminOptions {
  header?: string | undefined;
  onProcessAction?: UiViewAction | string | undefined;
}

export function buildDocumentAdminSection(options?: DocumentAdminOptions): UiViewSection {
  const buttons = [];
  if (options?.onProcessAction !== undefined) {
    const processAction: UiViewAction =
      typeof options.onProcessAction === 'string'
        ? { action: options.onProcessAction }
        : options.onProcessAction;
    buttons.push({
      text: 'Process Document',
      onClick: processAction,
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

import type { UiViewSection, UiViewWidget } from '../domain';

export interface StatusMessageOptions {
  message?: string;
  validationErrors?: string[];
}

export function buildStatusMessageSection(options: StatusMessageOptions): UiViewSection | undefined {
  const widgets: UiViewWidget[] = [];

  if (options.message && options.message.trim() !== '') {
    widgets.push({
      textParagraph: {
        text: options.message,
      },
    });
  }

  if (options.validationErrors && options.validationErrors.length > 0) {
    widgets.push({
      textParagraph: {
        text: `Validation Errors:\n${options.validationErrors.join('\n')}`,
      },
    });
  }

  if (widgets.length === 0) {
    return undefined;
  }

  return { widgets };
}

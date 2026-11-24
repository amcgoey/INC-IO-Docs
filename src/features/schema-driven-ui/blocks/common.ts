import type { UiViewAction, UiViewColor } from '../domain';

export const PRIMARY_ACTION_BUTTON_COLOR: UiViewColor = {
  red: 0.102,
  green: 0.451,
  blue: 0.91,
};

export function escapeCardHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function withOnChangeAction<T extends object>(
  props: T,
  onChangeAction: UiViewAction | undefined
): T & { onChangeAction?: UiViewAction } {
  return onChangeAction !== undefined ? { ...props, onChangeAction } : props;
}

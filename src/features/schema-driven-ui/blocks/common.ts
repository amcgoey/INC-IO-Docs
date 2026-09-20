import type { UiViewAction } from '../domain';

export function withOnChangeAction<T extends object>(
  props: T,
  onChangeAction: UiViewAction | undefined
): T & { onChangeAction?: UiViewAction } {
  return onChangeAction !== undefined ? { ...props, onChangeAction } : props;
}

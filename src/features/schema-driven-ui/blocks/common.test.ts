import { describe, it, expect } from 'vitest';
import { withOnChangeAction } from './common';

describe('withOnChangeAction', () => {
  it('returns original props when onChangeAction is undefined', () => {
    const props = { name: 'field1', label: 'Field 1' };
    const result = withOnChangeAction(props, undefined);
    expect(result).toEqual(props);
    expect(result.onChangeAction).toBeUndefined();
  });

  it('attaches onChangeAction when provided', () => {
    const props = { name: 'field1', label: 'Field 1' };
    const action = { action: 'onFormChange' };
    const result = withOnChangeAction(props, action);
    expect(result).toEqual({
      name: 'field1',
      label: 'Field 1',
      onChangeAction: action,
    });
  });
});

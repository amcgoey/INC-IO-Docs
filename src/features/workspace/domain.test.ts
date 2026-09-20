import { describe, it, expect } from 'vitest';
import { extractWorkspaceExecutionContext } from './domain';

describe('extractWorkspaceExecutionContext', () => {
  it('extracts formData from commonEventObject.formInputs', () => {
    const rawPayload = {
      commonEventObject: {
        formInputs: {
          SelectDocumentType: {
            stringInputs: {
              value: ['invoice'],
            },
          },
          title: {
            stringInputs: {
              value: ['My Invoice'],
            },
          },
          simpleField: 'simpleValue',
        },
        parameters: {
          action: 'onFormChange',
        },
      },
    };

    const context = extractWorkspaceExecutionContext(rawPayload);

    expect(context.formData).toEqual({
      SelectDocumentType: 'invoice',
      title: 'My Invoice',
      simpleField: 'simpleValue',
    });
    expect(context.actionName).toBe('onFormChange');
  });

  it('extracts validationErrors array when present in parameters', () => {
    const rawPayload = {
      commonEventObject: {
        parameters: {
          validationErrors: JSON.stringify(['Error 1', 'Error 2']),
        },
      },
    };

    const context = extractWorkspaceExecutionContext(rawPayload);
    expect(context.validationErrors).toEqual(['Error 1', 'Error 2']);
  });
});

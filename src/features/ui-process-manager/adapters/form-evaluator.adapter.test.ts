import { describe, it, expect, vi } from 'vitest';
import { FormEvaluatorAdapter } from './form-evaluator.adapter';
import type { UiProcessManifestPort } from '../ports';

describe('FormEvaluatorAdapter', () => {
  it('evaluates form change by resolving schema from manifestPort and executing evaluator function', async () => {
    const mockManifestPort: UiProcessManifestPort = {
      resolveDocumentTypeKey: vi.fn(),
      getAllDocumentTypes: vi.fn(),
      getDocumentTypeSchemas: vi.fn().mockResolvedValue({
        docSchema: { type: 'object' },
        uiSchema: { fields: [] },
      }),
    };

    const mockEvaluator = vi.fn().mockReturnValue({
      computedData: { foo: 'bar' },
      hiddenFields: ['secretField'],
      disabledFields: [],
    });

    const adapter = new FormEvaluatorAdapter(mockManifestPort, mockEvaluator);
    const result = await adapter.evaluate({ inputVal: '123' }, 'test-doc');

    expect(mockManifestPort.getDocumentTypeSchemas).toHaveBeenCalledWith('test-doc');
    expect(mockEvaluator).toHaveBeenCalledWith(
      { inputVal: '123' },
      { type: 'object' },
      { fields: [] }
    );
    expect(result).toEqual({
      computedData: { foo: 'bar' },
      hiddenFields: ['secretField'],
      disabledFields: [],
    });
  });

  it('evaluates gracefully when no documentTypeKey is provided', async () => {
    const mockManifestPort: UiProcessManifestPort = {
      resolveDocumentTypeKey: vi.fn(),
      getAllDocumentTypes: vi.fn(),
      getDocumentTypeSchemas: vi.fn().mockResolvedValue({}),
    };

    const mockEvaluator = vi.fn().mockReturnValue({
      computedData: {},
      hiddenFields: [],
      disabledFields: [],
    });

    const adapter = new FormEvaluatorAdapter(mockManifestPort, mockEvaluator);
    const result = await adapter.evaluate({});

    expect(mockManifestPort.getDocumentTypeSchemas).not.toHaveBeenCalled();
    expect(mockEvaluator).toHaveBeenCalledWith({}, undefined, undefined);
    expect(result.computedData).toEqual({});
  });
});

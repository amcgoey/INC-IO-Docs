import { describe, it, expect, vi } from 'vitest';
import { FormEvaluatorAdapter } from './form-evaluator.adapter';
import type { RawManifestProviderPort } from './manifest.adapter';

describe('FormEvaluatorAdapter', () => {
  it('evaluates form change by resolving schema from manifest and executing evaluator function', async () => {
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: {
          'test-doc': {
            documentSchema: { type: 'object' },
            documentUiSchema: { fields: [] },
          },
        },
      }),
    };

    const mockEvaluator = vi.fn().mockReturnValue({
      computedData: { foo: 'bar' },
      hiddenFields: ['secretField'],
      disabledFields: [],
    });

    const adapter = new FormEvaluatorAdapter(mockProvider, mockEvaluator);
    const result = await adapter.evaluate({ inputVal: '123' }, 'test-doc');

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
    const mockProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({}),
    };

    const mockEvaluator = vi.fn().mockReturnValue({
      computedData: {},
      hiddenFields: [],
      disabledFields: [],
    });

    const adapter = new FormEvaluatorAdapter(mockProvider, mockEvaluator);
    const result = await adapter.evaluate({});

    expect(mockEvaluator).toHaveBeenCalledWith({}, undefined, undefined);
    expect(result.computedData).toEqual({});
  });
});

import { describe, it, expect, vi } from 'vitest';
import { DocumentSpaceUiSchemaQueryAdapter } from './document-space-ui-schema-query';
import type { RawManifestProviderPort } from '../ports';

describe('DocumentSpaceUiSchemaQueryAdapter', () => {
  it('returns undefined if manifest has no DocumentSpaceTypes', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({}),
    };

    const adapter = new DocumentSpaceUiSchemaQueryAdapter(mockManifestProvider);
    const result = await adapter.getSpaceUiSchema('non-existent');

    expect(result).toBeUndefined();
    expect(mockManifestProvider.getRawManifest).toHaveBeenCalledOnce();
  });

  it('fetches and returns SpaceUiSchema from manifest DocumentSpaceTypes', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        DocumentSpaceTypes: [
          {
            id: 'space-alpha',
            displayName: 'Alpha Space',
            spaceUiSchema: {
              layout: ['spaceName'],
              fields: {
                spaceName: { widget: 'textInput', label: 'Custom Space Name' },
              },
            },
          },
        ],
      }),
    };

    const adapter = new DocumentSpaceUiSchemaQueryAdapter(mockManifestProvider);
    const result = await adapter.getSpaceUiSchema('space-alpha');

    expect(result).toBeDefined();
    expect(result?.layout).toEqual(['spaceName']);
    expect(result?.fields?.spaceName?.label).toBe('Custom Space Name');
  });

  it('returns undefined if spaceUiSchema is not present on space type', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        DocumentSpaceTypes: [
          {
            id: 'space-beta',
            displayName: 'Beta Space',
          },
        ],
      }),
    };

    const adapter = new DocumentSpaceUiSchemaQueryAdapter(mockManifestProvider);
    const result = await adapter.getSpaceUiSchema('space-beta');

    expect(result).toBeUndefined();
  });

  it('ensures evaluationOrder on SpaceUiSchema when fields with computeValue are present', async () => {
    const mockManifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        DocumentSpaceTypes: [
          {
            id: 'space-computed',
            displayName: 'Computed Space',
            spaceUiSchema: {
              layout: ['base', 'derived'],
              fields: {
                base: { widget: 'textInput', label: 'Base' },
                derived: {
                  widget: 'textInput',
                  label: 'Derived',
                  computeValue: { cat: [{ var: 'data.base' }, '-ext'] },
                },
              },
            },
          },
        ],
      }),
    };

    const mockEnsurer = vi.fn().mockImplementation((spaceUi) => {
      spaceUi.evaluationOrder = ['base', 'derived'];
      return spaceUi;
    });

    const adapter = new DocumentSpaceUiSchemaQueryAdapter(mockManifestProvider, mockEnsurer);
    const result = await adapter.getSpaceUiSchema('space-computed');

    expect(result).toBeDefined();
    expect(mockEnsurer).toHaveBeenCalled();
    expect(result?.evaluationOrder).toEqual(['base', 'derived']);
  });
});

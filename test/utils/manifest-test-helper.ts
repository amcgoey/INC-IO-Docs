import { vi, type MockInstance } from 'vitest';
import type { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';

/**
 * Cleanly spies on manifestProvider.getRawManifest and overrides allowedDocumentTypes
 * for a specific spaceTypeId in DocumentSpaceTypes.
 */
export function mockAllowedDocumentTypes(
  manifestProvider: AppManifestProvider,
  spaceTypeId: string,
  allowedDocumentTypes: string[]
): MockInstance {
  const originalGetRaw = manifestProvider.getRawManifest.bind(manifestProvider);
  return vi.spyOn(manifestProvider, 'getRawManifest').mockImplementation(async () => {
    const raw = (await originalGetRaw()) as { DocumentSpaceTypes?: Array<Record<string, unknown>> };
    return {
      ...raw,
      DocumentSpaceTypes: raw?.DocumentSpaceTypes?.map((st) =>
        st.id === spaceTypeId
          ? {
              ...st,
              spaceSchema: {
                ...(st.spaceSchema as Record<string, unknown>),
                allowedDocumentTypes,
              },
            }
          : st
      ),
    };
  });
}

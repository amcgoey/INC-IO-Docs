import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { DocumentSpaceManifestRegistryAdapter } from '../../src/features/document-space/adapters/document-space-manifest-registry';
import { DocumentSpaceService } from '../../src/features/document-space/domain';
import { GoogleDriveStorageAdapter } from '../../src/features/document-space/adapters/google-drive-storage-adapter';
import { LiveTestHarness } from './live-test-harness';

const canRunLiveSpaceValidation =
  !process.env.CI &&
  (LiveTestHarness.auth.hasLiveGoogleCredentials() ||
    Boolean(LiveTestHarness.auth.getDocumentLogTestFolderId()));

describe('DocumentSpaceTypes E2E Validation', () => {
  it.skipIf(!canRunLiveSpaceValidation)(
    'should validate all DocumentSpaceTypes against the real storage backend',
    async () => {
      // Uses LiveTestHarness auth (preserving GOOGLE_APPLICATION_CREDENTIALS / ADC fallback)
      // and retry-backed Drive client construction.
      const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
      const manifestProvider = new AppManifestProvider({ manifestPath });
      const registry = new DocumentSpaceManifestRegistryAdapter(manifestProvider);

      const auth = LiveTestHarness.auth.resolveLiveGoogleAuth();
      const driveClient = LiveTestHarness.clients.createLiveDriveClient(auth);
      const storageAdapter = new GoogleDriveStorageAdapter(driveClient);

      const service = new DocumentSpaceService(registry, storageAdapter);
      await service.initialize();

      const errors = await service.validateEndToEnd();

      // We expect no validation errors (all space types resolve successfully)
      expect(errors).toEqual([]);
    }
  );
});

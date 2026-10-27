import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { DocumentSpaceManifestRegistryAdapter } from '../../src/features/document-space/adapters/document-space-manifest-registry';
import { DocumentSpaceService } from '../../src/features/document-space/domain';
import { GoogleDriveStorageAdapter } from '../../src/features/document-space/adapters/google-drive-storage-adapter';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';

describe('DocumentSpaceTypes E2E Validation', () => {
  it('should verify production runtime manifest configures projects with ["communication-project"] and proposals with ["communication-proposal"]', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const registry = new DocumentSpaceManifestRegistryAdapter(manifestProvider);
    const spaceTypes = await registry.getDocumentSpaceTypes();

    const projects = spaceTypes.find((st) => st.id === 'projects');
    expect(projects).toBeDefined();
    expect(projects?.spaceSchema.allowedDocumentTypes).toEqual(['communication-project']);

    const proposals = spaceTypes.find((st) => st.id === 'proposals');
    expect(proposals).toBeDefined();
    expect(proposals?.spaceSchema.allowedDocumentTypes).toEqual(['communication-proposal']);
  });

  it.skipIf(process.env.CI || !process.env.GOOGLE_APPLICATION_CREDENTIALS)(
    'should validate all DocumentSpaceTypes against the real storage backend',
    async () => {
    // This test performs an actual end-to-end network request using the configured storage adapters
    // to ensure that the document space configurations are pointing to valid, accessible locations.
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const registry = new DocumentSpaceManifestRegistryAdapter(manifestProvider);
    
    // Instantiate real Google Drive client (requires local ADC or Service Account)
    const driveClient = new GoogleDriveClient();
    const storageAdapter = new GoogleDriveStorageAdapter(driveClient);
    
    const service = new DocumentSpaceService(registry, storageAdapter);
    await service.initialize();
    
    const errors = await service.validateEndToEnd();
    
    // We expect no validation errors (all space types resolve successfully)
    expect(errors).toEqual([]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppManifestProvider } from './app-manifest-provider';

describe('AppManifestProvider', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-manifest-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('throws an error if manifest file does not exist', async () => {
    const nonExistentPath = path.join(tempDir, 'missing-manifest.json');
    const provider = new AppManifestProvider({ manifestPath: nonExistentPath });
    await expect(provider.getRawManifest()).rejects.toThrow();
  });

  it('throws an error if manifest file contains malformed JSON', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, '{ malformed json: true }', 'utf-8');

    const provider = new AppManifestProvider({ manifestPath });
    await expect(provider.getRawManifest()).rejects.toThrow(/invalid json/i);
  });

  it('throws an error if manifest structure is invalid (missing documentTypes array)', async () => {
    const manifestPath = path.join(tempDir, 'manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({ wrongField: [] }), 'utf-8');

    const provider = new AppManifestProvider({ manifestPath });
    await expect(provider.getRawManifest()).rejects.toThrow(/invalid manifest/i);
  });

  describe('readParsedSchema', () => {
    it('reads and parses schema file relative to manifest directory', async () => {
      const manifestPath = path.join(tempDir, 'sub', 'manifest.json');
      const schemaRelPath = './schemas/test.json';
      const schemaFullPath = path.join(tempDir, 'sub', 'schemas', 'test.json');
      await fs.mkdir(path.join(tempDir, 'sub', 'schemas'), { recursive: true });
      await fs.writeFile(schemaFullPath, '{"key": "test"}', 'utf-8');

      const provider = new AppManifestProvider({ manifestPath });
      const content = await provider.readParsedSchema(schemaRelPath);
      expect(content).toEqual({ key: 'test' });
    });

    it('throws error if schema file cannot be read', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const provider = new AppManifestProvider({ manifestPath });
      await expect(provider.readParsedSchema('./missing.json')).rejects.toThrow(
        /failed to read documenttype file/i
      );
    });

    it('throws error if schema file contains malformed JSON', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const schemaRelPath = './schemas/invalid.json';
      const schemaFullPath = path.join(tempDir, 'schemas', 'invalid.json');
      await fs.mkdir(path.join(tempDir, 'schemas'), { recursive: true });
      await fs.writeFile(schemaFullPath, '{ not valid json }', 'utf-8');

      const provider = new AppManifestProvider({ manifestPath });
      await expect(provider.readParsedSchema(schemaRelPath)).rejects.toThrow(
        /invalid json/i
      );
    });
  });

  describe('getRawManifest', () => {
    it('returns raw parsed manifest object and caches it', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const rawData = {
        documentTypes: ['./schemas/test.json'],
        configuration: {
          sheets: {
            spreadsheetId: 'sheet-123',
          },
        },
      };
      await fs.writeFile(manifestPath, JSON.stringify(rawData), 'utf-8');

      const provider = new AppManifestProvider({ manifestPath });
      const manifest = await provider.getRawManifest();
      expect(manifest).toEqual(rawData);

      // Mutate file on disk to confirm caching
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: [] }), 'utf-8');
      const cached = await provider.getRawManifest();
      expect(cached).toEqual(rawData);
    });
  });

  describe('Configuration Provider', () => {
    it('loads and returns drive and workspace configuration when defined in manifest', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            workspace: {
              appTitle: 'Custom Docs App',
              actionButtonText: 'Submit Document',
              defaultDocumentType: 'custom-type',
              defaultEventName: 'onCustomSubmit',
            },
            drive: {
              defaultFolderName: 'SpecialFolder',
              maxRetries: 5,
              initialDelayMs: 2000,
              backoffFactor: 3,
            },
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });

      const driveConfig = await provider.getDriveConfig();
      expect(driveConfig).toEqual({
        defaultFolderName: 'SpecialFolder',
        maxRetries: 5,
        initialDelayMs: 2000,
        backoffFactor: 3,
      });

      const wsConfig = await provider.getWorkspaceConfig();
      expect(wsConfig).toEqual({
        appTitle: 'Custom Docs App',
        actionButtonText: 'Submit Document',
        defaultDocumentType: 'custom-type',
        defaultEventName: 'onCustomSubmit',
      });
    });

    it('returns undefined for drive/workspace configs when configuration block is absent in manifest', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: [] }), 'utf-8');

      const provider = new AppManifestProvider({ manifestPath });

      const driveConfig = await provider.getDriveConfig();
      expect(driveConfig).toBeUndefined();

      const wsConfig = await provider.getWorkspaceConfig();
      expect(wsConfig).toBeUndefined();
    });

    it('caches configuration so subsequent calls do not re-read from disk', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            workspace: { appTitle: 'Initial Title' },
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });

      const wsConfig1 = await provider.getWorkspaceConfig();
      expect(wsConfig1?.appTitle).toBe('Initial Title');

      // Mutate file on disk to verify cache is used
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: { workspace: { appTitle: 'Mutated Title' } },
        }),
        'utf-8'
      );

      const wsConfig2 = await provider.getWorkspaceConfig();
      expect(wsConfig2?.appTitle).toBe('Initial Title');
    });

    it('throws error when manifest contains invalid configuration types', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            drive: {
              maxRetries: 'five', // invalid type
            },
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });

      await expect(provider.getDriveConfig()).rejects.toThrow(/invalid manifest/i);
    });
  });
});

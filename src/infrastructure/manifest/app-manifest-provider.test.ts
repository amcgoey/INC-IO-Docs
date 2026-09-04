import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppManifestProvider } from './app-manifest-provider';

describe('AppManifestProvider', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-manifest-test-'));
    vi.unstubAllEnvs();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('throws an error if neither options.manifestPath nor APP_MANIFEST_PATH is set', () => {
    delete process.env.APP_MANIFEST_PATH;
    expect(() => new AppManifestProvider()).toThrow(
      /Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable./
    );
  });

  it('resolves manifest strictly from APP_MANIFEST_PATH environment variable', async () => {
    const manifestPath = path.join(tempDir, 'env-manifest.json');
    await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: [] }), 'utf-8');
    vi.stubEnv('APP_MANIFEST_PATH', manifestPath);

    const provider = new AppManifestProvider();
    const manifest = await provider.getRawManifest();
    expect(manifest).toEqual({ documentTypes: [] });
  });

  it('prefers options.manifestPath over APP_MANIFEST_PATH environment variable', async () => {
    const optManifestPath = path.join(tempDir, 'opt-manifest.json');
    await fs.writeFile(optManifestPath, JSON.stringify({ documentTypes: ['opt'] }), 'utf-8');
    const envManifestPath = path.join(tempDir, 'env-manifest.json');
    await fs.writeFile(envManifestPath, JSON.stringify({ documentTypes: ['env'] }), 'utf-8');
    vi.stubEnv('APP_MANIFEST_PATH', envManifestPath);

    const provider = new AppManifestProvider({ manifestPath: optManifestPath });
    const manifest = await provider.getRawManifest();
    expect(manifest).toEqual({ documentTypes: ['opt'] });
  });

  it('throws an error if manifest file does not exist via options.manifestPath', async () => {
    const nonExistentPath = path.join(tempDir, 'missing-opt-manifest.json');
    const provider = new AppManifestProvider({ manifestPath: nonExistentPath });
    await expect(provider.getRawManifest()).rejects.toThrow(/Failed to read manifest file/i);
  });

  it('throws an error if manifest file does not exist via APP_MANIFEST_PATH', async () => {
    const nonExistentPath = path.join(tempDir, 'missing-env-manifest.json');
    vi.stubEnv('APP_MANIFEST_PATH', nonExistentPath);
    const provider = new AppManifestProvider();
    await expect(provider.getRawManifest()).rejects.toThrow(/Failed to read manifest file/i);
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

  describe('loadAllParsedSchemas', () => {
    it('loads and returns all parsed schemas referenced in documentTypes', async () => {
      const schema1 = { key: 'type-1', name: 'Type 1' };
      const schema2 = { key: 'type-2', name: 'Type 2' };
      await fs.writeFile(path.join(tempDir, 'type1.json'), JSON.stringify(schema1));
      await fs.writeFile(path.join(tempDir, 'type2.json'), JSON.stringify(schema2));
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ documentTypes: ['./type1.json', './type2.json'] })
      );

      const provider = new AppManifestProvider({ manifestPath });
      const schemas = await provider.loadAllParsedSchemas();
      expect(schemas).toEqual([schema1, schema2]);
    });

    it('throws error if a referenced document type file is missing', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ documentTypes: ['./missing-type.json'] })
      );

      const provider = new AppManifestProvider({ manifestPath });
      await expect(provider.loadAllParsedSchemas()).rejects.toThrow(
        /failed to read documenttype file/i
      );
    });

    it('throws error if a referenced document type file contains malformed JSON', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const invalidPath = path.join(tempDir, 'invalid.json');
      await fs.writeFile(invalidPath, '{ malformed');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({ documentTypes: ['./invalid.json'] })
      );

      const provider = new AppManifestProvider({ manifestPath });
      await expect(provider.loadAllParsedSchemas()).rejects.toThrow(
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

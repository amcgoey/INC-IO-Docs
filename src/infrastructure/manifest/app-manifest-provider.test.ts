import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AppManifestProvider,
  SheetsConfigurationSchema,
  WorkspaceConfigurationSchema,
} from './app-manifest-provider';

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

  describe('getRawManifest', () => {
    it('returns raw parsed manifest object and caches it', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      const rawData = {
        documentTypes: ['./schemas/test.json'],
        configuration: {
          sheets: {},
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
    it('exposes defaultDocumentType, defaultDocumentSpaceType, and timeZone on WorkspaceConfigurationSchema', () => {
      const keys = Object.keys(WorkspaceConfigurationSchema.properties);
      expect(keys.sort()).toEqual(['defaultDocumentSpaceType', 'defaultDocumentType', 'timeZone']);
    });

    it('exposes only maxRetries, initialDelayMs, and backoffFactor on SheetsConfigurationSchema', () => {
      const keys = Object.keys(SheetsConfigurationSchema.properties);
      expect(keys.sort()).toEqual(['backoffFactor', 'initialDelayMs', 'maxRetries']);
    });

    it('loads and returns drive and workspace configuration when defined in manifest', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            workspace: {
              defaultDocumentSpaceType: 'projects',
              defaultDocumentType: 'custom-type',
              timeZone: 'America/New_York',
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
        defaultDocumentSpaceType: 'projects',
        defaultDocumentType: 'custom-type',
        timeZone: 'America/New_York',
      });
    });

    it('loads and returns sheets configuration when defined in manifest', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            sheets: {
              maxRetries: 4,
              initialDelayMs: 500,
              backoffFactor: 2,
            },
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });

      const sheetsConfig = await provider.getSheetsConfig();
      expect(sheetsConfig).toEqual({
        maxRetries: 4,
        initialDelayMs: 500,
        backoffFactor: 2,
      });
    });

    it('preserves configuration.documentLog and DocumentSpaceTypes[].documentLog in getRawManifest()', async () => {
      const manifestPath = path.join(tempDir, 'document-log-manifest.json');
      const rawData = {
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: {
          sheets: {
            maxRetries: 3,
          },
          documentLog: {
            preferredFolderPath: '1 Admin',
            fileNameContains: 'Document Log',
            excludePrefixes: ['Copy of '],
            excludeSubstrings: ['Template'],
            templateSpreadsheetId: 'template-123',
            copyNameTemplate: '{{DocumentSpace.name}} Document Log',
          },
        },
        DocumentSpaceTypes: [
          {
            id: 'projects',
            displayName: 'Projects',
            documentLog: {
              preferredFolderPath: '00 Admin',
            },
          },
        ],
      };
      await fs.writeFile(manifestPath, JSON.stringify(rawData), 'utf-8');

      const provider = new AppManifestProvider({ manifestPath });

      expect(await provider.getSheetsConfig()).toEqual({ maxRetries: 3 });
      expect(await provider.getRawManifest()).toEqual(rawData);
    });

    it('loads production assets/manifest.json without legacy sheets defaultHeaderRangeName or defaultDataRangeName keys', async () => {
      const prodManifestPath = path.resolve(__dirname, '../../../assets/manifest.json');
      const provider = new AppManifestProvider({ manifestPath: prodManifestPath });
      const rawManifest = (await provider.getRawManifest()) as {
        configuration?: { sheets?: Record<string, unknown> };
      };
      if (rawManifest.configuration?.sheets !== undefined) {
        expect(rawManifest.configuration.sheets).not.toHaveProperty('defaultHeaderRangeName');
        expect(rawManifest.configuration.sheets).not.toHaveProperty('defaultDataRangeName');
      }
      const sheetsConfig = await provider.getSheetsConfig();
      if (sheetsConfig !== undefined) {
        expect(sheetsConfig).not.toHaveProperty('defaultHeaderRangeName');
        expect(sheetsConfig).not.toHaveProperty('defaultDataRangeName');
      }
    });

    it('returns undefined for drive/workspace/sheets configs when configuration block is absent in manifest', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: [] }), 'utf-8');

      const provider = new AppManifestProvider({ manifestPath });

      const driveConfig = await provider.getDriveConfig();
      expect(driveConfig).toBeUndefined();

      const wsConfig = await provider.getWorkspaceConfig();
      expect(wsConfig).toBeUndefined();

      const sheetsConfig = await provider.getSheetsConfig();
      expect(sheetsConfig).toBeUndefined();
    });

    it('caches configuration so subsequent calls do not re-read from disk', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            workspace: { defaultDocumentType: 'Initial Type' },
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });

      const wsConfig1 = await provider.getWorkspaceConfig();
      expect(wsConfig1?.defaultDocumentType).toBe('Initial Type');

      // Mutate file on disk to verify cache is used
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: { workspace: { defaultDocumentType: 'Mutated Type' } },
        }),
        'utf-8'
      );

      const wsConfig2 = await provider.getWorkspaceConfig();
      expect(wsConfig2?.defaultDocumentType).toBe('Initial Type');
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

    it('loads manifest with optional aliases mapping', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          aliases: {
            contacts: 'assets/aliases/contacts.json',
            vendors: 'assets/aliases/vendors.json',
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });
      const rawManifest = await provider.getRawManifest() as { aliases?: Record<string, string> };
      expect(rawManifest.aliases).toEqual({
        contacts: 'assets/aliases/contacts.json',
        vendors: 'assets/aliases/vendors.json',
      });
    });

    it('fails fast on load when configuration.workspace.timeZone is invalid even with empty documentTypes', async () => {
      const manifestPath = path.join(tempDir, 'invalid-tz-manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            workspace: {
              timeZone: 'Mars/Olympus_Mons',
            },
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });
      await expect(provider.getRawManifest()).rejects.toThrow(/timeZone/i);
    });

    it('fails fast on load when configuration.workspace.timeZone is empty or whitespace', async () => {
      const manifestPath = path.join(tempDir, 'empty-tz-manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: [],
          configuration: {
            workspace: {
              timeZone: '   ',
            },
          },
        }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });
      await expect(provider.getWorkspaceConfig()).rejects.toThrow(/timeZone/i);
    });
  });

  describe('Memoization and immutability', () => {
    it('memoizes readParsedSchema by resolved path so repeated or equivalent reads do not hit disk again', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: ['./schemas/doc.json'] }), 'utf-8');
      const schemaDir = path.join(tempDir, 'schemas');
      const schemaPath = path.join(schemaDir, 'doc.json');
      await fs.mkdir(schemaDir, { recursive: true });
      await fs.writeFile(schemaPath, JSON.stringify({ key: 'doc', version: 1 }), 'utf-8');

      const provider = new AppManifestProvider({ manifestPath });
      const first = await provider.readParsedSchema('./schemas/doc.json');
      expect(first).toEqual({ key: 'doc', version: 1 });

      // Overwrite on disk to confirm memoization across equivalent relative paths
      await fs.writeFile(schemaPath, JSON.stringify({ key: 'doc', version: 2 }), 'utf-8');

      const second = await provider.readParsedSchema('schemas/doc.json');
      expect(second).toEqual({ key: 'doc', version: 1 });
    });

    it('deduplicates concurrent readParsedSchema calls and does not cache failures', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(manifestPath, JSON.stringify({ documentTypes: [] }), 'utf-8');
      const schemaDir = path.join(tempDir, 'schemas');
      const schemaPath = path.join(schemaDir, 'concurrent.json');
      await fs.mkdir(schemaDir, { recursive: true });

      const provider = new AppManifestProvider({ manifestPath });
      await expect(provider.readParsedSchema('./schemas/concurrent.json')).rejects.toThrow(
        /failed to read documenttype file/i
      );

      // Creating the file after a failed read should succeed
      await fs.writeFile(schemaPath, JSON.stringify({ key: 'concurrent', nested: { count: 1 } }), 'utf-8');
      const [a, b] = await Promise.all([
        provider.readParsedSchema('./schemas/concurrent.json'),
        provider.readParsedSchema('schemas/concurrent.json'),
      ]);
      expect(a).toEqual({ key: 'concurrent', nested: { count: 1 } });
      expect(b).toEqual({ key: 'concurrent', nested: { count: 1 } });
      expect(a).not.toBe(b);
    });

    it('returns structuredClone copies from getRawManifest, readParsedSchema, and configuration getters so caller mutations do not leak', async () => {
      const manifestPath = path.join(tempDir, 'manifest.json');
      await fs.writeFile(
        manifestPath,
        JSON.stringify({
          documentTypes: ['./schemas/doc.json'],
          configuration: {
            workspace: { defaultDocumentType: 'comm', timeZone: 'America/New_York' },
            drive: { defaultFolderName: 'Unfiled' },
            sheets: { maxRetries: 3 },
          },
        }),
        'utf-8'
      );
      const schemaDir = path.join(tempDir, 'schemas');
      await fs.mkdir(schemaDir, { recursive: true });
      await fs.writeFile(
        path.join(schemaDir, 'doc.json'),
        JSON.stringify({ key: 'doc', nested: { items: ['a', 'b'] } }),
        'utf-8'
      );

      const provider = new AppManifestProvider({ manifestPath });

      const raw1 = (await provider.getRawManifest()) as { documentTypes: string[]; configuration: { workspace: { defaultDocumentType: string } } };
      raw1.documentTypes.push('mutated');
      raw1.configuration.workspace.defaultDocumentType = 'mutated';

      const raw2 = (await provider.getRawManifest()) as { documentTypes: string[]; configuration: { workspace: { defaultDocumentType: string } } };
      expect(raw2.documentTypes).toEqual(['./schemas/doc.json']);
      expect(raw2.configuration.workspace.defaultDocumentType).toBe('comm');

      const schema1 = (await provider.readParsedSchema('./schemas/doc.json')) as { nested: { items: string[] } };
      schema1.nested.items.push('mutated');

      const schema2 = (await provider.readParsedSchema('./schemas/doc.json')) as { nested: { items: string[] } };
      expect(schema2.nested.items).toEqual(['a', 'b']);

      const ws1 = await provider.getWorkspaceConfig();
      ws1!.defaultDocumentType = 'mutated';
      expect((await provider.getWorkspaceConfig())?.defaultDocumentType).toBe('comm');

      const drive1 = await provider.getDriveConfig();
      drive1!.defaultFolderName = 'Mutated';
      expect((await provider.getDriveConfig())?.defaultFolderName).toBe('Unfiled');

      const sheets1 = await provider.getSheetsConfig();
      sheets1!.maxRetries = 99;
      expect((await provider.getSheetsConfig())?.maxRetries).toBe(3);
    });
  });
});





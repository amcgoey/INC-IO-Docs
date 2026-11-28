import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import { GoogleSheetsClient } from '../../src/infrastructure/sheets';
import { LiveTestHarness } from '../live/live-test-harness';

const TRACKED_ENV_KEYS = [
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DOCUMENT_LOG_TEST_FOLDER_ID',
  'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
] as const;

describe('LiveTestHarness (modular core facade)', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const key of TRACKED_ENV_KEYS) {
      originalEnv[key] = Object.prototype.hasOwnProperty.call(process.env, key)
        ? process.env[key]
        : undefined;
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const key of TRACKED_ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it('exposes focused auth, clients, cleanup, and sheets modules without importing app or feature wiring', () => {
    expect(typeof LiveTestHarness.auth.resolveLiveGoogleAuth).toBe('function');
    expect(typeof LiveTestHarness.auth.hasLiveGoogleCredentials).toBe('function');
    expect(typeof LiveTestHarness.clients.createLiveDriveClient).toBe('function');
    expect(typeof LiveTestHarness.clients.createLiveSheetsClient).toBe('function');
    expect(typeof LiveTestHarness.cleanup.createCleanupTracker).toBe('function');
    expect(typeof LiveTestHarness.sheets.ensureClearedPositiveTable).toBe('function');
    expect(typeof LiveTestHarness.sheets.readSheetsGridLayout).toBe('function');

    const harnessFiles = [
      path.resolve(__dirname, '../live/live-test-harness.ts'),
      path.resolve(__dirname, '../live/harness/auth-clients.ts'),
      path.resolve(__dirname, '../live/harness/cleanup.ts'),
      path.resolve(__dirname, '../live/harness/sheets-helpers.ts'),
    ];
    for (const filePath of harnessFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      expect(content).not.toMatch(/src\/app\//);
      expect(content).not.toMatch(/src\/features\//);
      expect(content).not.toMatch(/PdfProcessor|SourceParser|AppManifestProvider/);
    }
  });

  it('constructs retry-backed Drive and Sheets clients via LiveTestHarness.clients', () => {
    vi.stubEnv('GOOGLE_ACCESS_TOKEN', 'ya29.test-access-cred');

    const auth = LiveTestHarness.auth.resolveLiveGoogleAuth();
    const driveClient = LiveTestHarness.clients.createLiveDriveClient(auth);
    const { sheetsApi, sheetsClient } = LiveTestHarness.clients.createLiveSheetsClient(auth);

    expect(driveClient).toBeInstanceOf(GoogleDriveClient);
    expect(sheetsClient).toBeInstanceOf(GoogleSheetsClient);
    expect(sheetsApi).toBeDefined();
  });

  describe('hardened Drive teardown (LiveTestHarness.cleanup)', () => {
    it('trashes top-level tracked folder first and skips redundant child spreadsheet trashing when folder trash succeeds', async () => {
      const tracker = LiveTestHarness.cleanup.createCleanupTracker({
        protectedIds: ['protected-root-folder', 'protected-template-id'],
      });
      tracker.trackFolder('space-folder-1');
      tracker.trackFolder('admin-folder-1', 'space-folder-1');
      tracker.trackSpreadsheet('spreadsheet-1', 'admin-folder-1');
      tracker.track('protected-root-folder');
      tracker.trackSpreadsheet('protected-template-id');

      const trashMock = vi.fn().mockResolvedValue(undefined);
      const loggerMock = vi.fn();

      const failures = await tracker.trashAll({ trash: trashMock }, { logger: loggerMock });

      expect(failures).toEqual([]);
      expect(loggerMock).not.toHaveBeenCalled();
      expect(trashMock).toHaveBeenCalledTimes(1);
      expect(trashMock).toHaveBeenCalledWith('space-folder-1');
    });

    it('logs failures instead of swallowing them and falls back to explicitly trashing tracked spreadsheet artifacts when top-level folder trashing fails', async () => {
      const tracker = LiveTestHarness.cleanup.createCleanupTracker();
      tracker.trackFolder('space-folder-1');
      tracker.trackFolder('admin-folder-1', 'space-folder-1');
      tracker.trackSpreadsheet('spreadsheet-1', 'admin-folder-1');
      tracker.track('file-1', { kind: 'file', parentFolderId: 'space-folder-1' });

      const folderErr = new Error('Insufficient permissions to trash folder');
      const trashMock = vi.fn().mockImplementation(async (id: string) => {
        if (id === 'space-folder-1') {
          throw folderErr;
        }
      });
      const loggerMock = vi.fn();

      const failures = await tracker.trashAll({ trash: trashMock }, { logger: loggerMock });

      expect(failures).toEqual([{ id: 'space-folder-1', kind: 'folder', error: folderErr }]);
      expect(loggerMock).toHaveBeenCalledTimes(1);
      expect(loggerMock.mock.calls[0]?.[0]).toContain('space-folder-1');
      expect(loggerMock.mock.calls[0]?.[1]).toBe(folderErr);

      expect(trashMock.mock.calls.map((c) => c[0])).toEqual([
        'space-folder-1',
        'spreadsheet-1',
        'file-1',
        'admin-folder-1',
      ]);
    });

    it('logs individual failures when fallback spreadsheet trashing also fails and continues cleaning remaining artifacts', async () => {
      const tracker = LiveTestHarness.cleanup.createCleanupTracker();
      tracker.trackFolder('space-folder-2');
      tracker.trackSpreadsheet('spreadsheet-fail', 'space-folder-2');
      tracker.trackSpreadsheet('spreadsheet-ok', 'space-folder-2');

      const folderErr = new Error('Folder trash denied');
      const sheetErr = new Error('Spreadsheet trash denied');
      const trashMock = vi.fn().mockImplementation(async (id: string) => {
        if (id === 'space-folder-2') throw folderErr;
        if (id === 'spreadsheet-fail') throw sheetErr;
      });
      const loggerMock = vi.fn();

      const failures = await tracker.trashAll({ trash: trashMock }, { logger: loggerMock });

      expect(failures).toHaveLength(2);
      expect(failures).toEqual([
        { id: 'space-folder-2', kind: 'folder', error: folderErr },
        { id: 'spreadsheet-fail', kind: 'spreadsheet', error: sheetErr },
      ]);
      expect(loggerMock).toHaveBeenCalledTimes(2);
      expect(trashMock).toHaveBeenCalledWith('spreadsheet-ok');
    });
  });
});

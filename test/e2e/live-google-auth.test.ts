import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import {
  loadEnvIfPresent,
  getDocumentLogTestFolderId,
  getSubmittalCoverSheetTemplateId,
  hasLiveGoogleCredentials,
  resolveLiveGoogleAuth,
} from './utils/live-google-auth';

const TRACKED_ENV_KEYS = [
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'DOCUMENT_LOG_TEST_FOLDER_ID',
  'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
  'LIVE_AUTH_TEST_KEY',
] as const;

describe('live-google-auth', () => {
  let tmpDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {};
    for (const key of TRACKED_ENV_KEYS) {
      originalEnv[key] = Object.prototype.hasOwnProperty.call(process.env, key)
        ? process.env[key]
        : undefined;
      delete process.env[key];
    }

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-google-auth-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadEnvIfPresent', () => {
    it('does not throw when the target .env path is missing', () => {
      const missingPath = path.join(tmpDir, 'nonexistent.env');
      expect(() => loadEnvIfPresent(missingPath)).not.toThrow();
    });

    it('loads values only when process.env key is unset and preserves explicit overrides including empty string', () => {
      const envPath = path.join(tmpDir, '.env');
      fs.writeFileSync(
        envPath,
        [
          '# Comment line',
          'DOCUMENT_LOG_TEST_FOLDER_ID=folder-from-file',
          'LIVE_AUTH_TEST_KEY=value-from-file',
          'GOOGLE_ACCESS_TOKEN=cred-from-file',
        ].join('\n'),
        'utf-8'
      );

      process.env.DOCUMENT_LOG_TEST_FOLDER_ID = '';
      vi.stubEnv('GOOGLE_ACCESS_TOKEN', 'override-cred');

      loadEnvIfPresent(envPath);

      expect(process.env.DOCUMENT_LOG_TEST_FOLDER_ID).toBe('');
      expect(process.env.GOOGLE_ACCESS_TOKEN).toBe('override-cred');
      expect(process.env.LIVE_AUTH_TEST_KEY).toBe('value-from-file');
    });

    it('supports fallback line parsing when process.loadEnvFile is unavailable', () => {
      const envPath = path.join(tmpDir, '.env');
      fs.writeFileSync(
        envPath,
        [
          '# Comment line',
          '',
          'DOCUMENT_LOG_TEST_FOLDER_ID=folder-fallback',
          'LIVE_AUTH_TEST_KEY=a=b=c',
        ].join('\n'),
        'utf-8'
      );

      const originalLoadEnvFile = process.loadEnvFile;
      Object.defineProperty(process, 'loadEnvFile', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      try {
        process.env.DOCUMENT_LOG_TEST_FOLDER_ID = '';
        loadEnvIfPresent(envPath);

        expect(process.env.DOCUMENT_LOG_TEST_FOLDER_ID).toBe('');
        expect(process.env.LIVE_AUTH_TEST_KEY).toBe('a=b=c');
      } finally {
        Object.defineProperty(process, 'loadEnvFile', {
          value: originalLoadEnvFile,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  describe('getDocumentLogTestFolderId', () => {
    it('returns undefined when DOCUMENT_LOG_TEST_FOLDER_ID is unset or blank', () => {
      expect(getDocumentLogTestFolderId()).toBeUndefined();

      process.env.DOCUMENT_LOG_TEST_FOLDER_ID = '   ';
      expect(getDocumentLogTestFolderId()).toBeUndefined();
    });

    it('returns trimmed folder ID from environment or .env', () => {
      process.env.DOCUMENT_LOG_TEST_FOLDER_ID = '  folder-xyz-789  ';
      expect(getDocumentLogTestFolderId()).toBe('folder-xyz-789');
    });
  });

  describe('getSubmittalCoverSheetTemplateId', () => {
    it('returns undefined when SUBMITTAL_COVER_SHEET_TEMPLATE_ID is unset or blank', () => {
      expect(getSubmittalCoverSheetTemplateId()).toBeUndefined();

      process.env.SUBMITTAL_COVER_SHEET_TEMPLATE_ID = '   ';
      expect(getSubmittalCoverSheetTemplateId()).toBeUndefined();
    });

    it('returns trimmed template ID from environment or .env', () => {
      process.env.SUBMITTAL_COVER_SHEET_TEMPLATE_ID = '  tpl-abc-123  ';
      expect(getSubmittalCoverSheetTemplateId()).toBe('tpl-abc-123');
    });
  });

  describe('resolveLiveGoogleAuth', () => {
    it('prefers GOOGLE_ACCESS_TOKEN over OAuth refresh credentials and ADC', () => {
      const accessCred = 'ya29.explicit-access-cred';
      const clientIdVal = 'client-id-123';
      const clientKeyVal = 'client-cred-456';
      const refreshCred = 'refresh-cred-789';

      vi.stubEnv('GOOGLE_ACCESS_TOKEN', accessCred);
      process.env.GOOGLE_CLIENT_ID = clientIdVal;
      vi.stubEnv('GOOGLE_CLIENT_SECRET', clientKeyVal);
      vi.stubEnv('GOOGLE_REFRESH_TOKEN', refreshCred);

      const auth = resolveLiveGoogleAuth();

      expect(auth).toBeInstanceOf(OAuth2Client);
      expect((auth as OAuth2Client).credentials.access_token).toBe(accessCred);
      expect((auth as OAuth2Client).credentials.refresh_token).toBeUndefined();
    });

    it('uses OAuth refresh credentials when GOOGLE_ACCESS_TOKEN is unset', () => {
      const clientIdVal = 'client-id-123';
      const clientKeyVal = 'client-cred-456';
      const refreshCred = 'refresh-cred-789';

      process.env.GOOGLE_CLIENT_ID = clientIdVal;
      vi.stubEnv('GOOGLE_CLIENT_SECRET', clientKeyVal);
      vi.stubEnv('GOOGLE_REFRESH_TOKEN', refreshCred);

      const auth = resolveLiveGoogleAuth();

      expect(auth).toBeInstanceOf(OAuth2Client);
      expect((auth as OAuth2Client).credentials.refresh_token).toBe(refreshCred);
      expect((auth as OAuth2Client)._clientId).toBe(clientIdVal);
      expect((auth as OAuth2Client)._clientSecret).toBe(clientKeyVal);
    });

    it('falls back to GoogleAuth with Drive and Sheets scopes without network calls when credentials are unset', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        throw new Error('Unexpected network call during resolveLiveGoogleAuth');
      });

      const auth = resolveLiveGoogleAuth();

      expect(auth).toBeInstanceOf(GoogleAuth);
      expect((auth as unknown as { scopes?: string[] }).scopes).toEqual([
        'https://www.googleapis.com/auth/drive',
        'https://www.googleapis.com/auth/spreadsheets',
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('hasLiveGoogleCredentials', () => {
    it('returns false when no token, complete OAuth triad, or GOOGLE_APPLICATION_CREDENTIALS is set', () => {
      expect(hasLiveGoogleCredentials()).toBe(false);

      vi.stubEnv('GOOGLE_CLIENT_ID', 'client-only');
      expect(hasLiveGoogleCredentials()).toBe(false);
    });

    it('returns true when GOOGLE_ACCESS_TOKEN, full OAuth refresh triad, or GOOGLE_APPLICATION_CREDENTIALS is set', () => {
      vi.stubEnv('GOOGLE_ACCESS_TOKEN', 'ya29.access');
      expect(hasLiveGoogleCredentials()).toBe(true);
      delete process.env.GOOGLE_ACCESS_TOKEN;

      vi.stubEnv('GOOGLE_CLIENT_ID', 'cid');
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'csec');
      vi.stubEnv('GOOGLE_REFRESH_TOKEN', 'cref');
      expect(hasLiveGoogleCredentials()).toBe(true);
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REFRESH_TOKEN;

      vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', '/path/to/adc.json');
      expect(hasLiveGoogleCredentials()).toBe(true);
    });
  });
});

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';

const LIVE_GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/spreadsheets',
] as const;

function stripSurroundingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Loads environment variables from a `.env` file if present without throwing when missing
 * and without overwriting keys already defined on `process.env`.
 */
export function loadEnvIfPresent(envFilePath?: string): void {
  const targetPath = envFilePath ?? path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(targetPath)) {
    return;
  }

  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(targetPath);
    return;
  }

  const content = fs.readFileSync(targetPath, 'utf-8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    process.env[key] = stripSurroundingQuotes(rawValue);
  }
}

/**
 * Returns the trimmed scratch Drive folder ID used for live DocumentLog E2E tests,
 * or `undefined` when unset or blank.
 */
export function getDocumentLogTestFolderId(): string | undefined {
  loadEnvIfPresent();
  return process.env.DOCUMENT_LOG_TEST_FOLDER_ID?.trim() || undefined;
}

/**
 * Resolves Google API credentials for live E2E tests in priority order:
 * 1. `GOOGLE_ACCESS_TOKEN`
 * 2. `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`
 * 3. Ambient Google ADC via `GoogleAuth` scoped for Drive and Sheets
 */
export function resolveLiveGoogleAuth(): OAuth2Client | GoogleAuth {
  loadEnvIfPresent();

  const accessCred = process.env.GOOGLE_ACCESS_TOKEN?.trim();
  if (accessCred) {
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: accessCred });
    return oauth2Client;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientKey = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const refreshCred = process.env.GOOGLE_REFRESH_TOKEN?.trim();
  if (clientId && clientKey && refreshCred) {
    const oauth2Client = new OAuth2Client(clientId, clientKey);
    oauth2Client.setCredentials({ refresh_token: refreshCred });
    return oauth2Client;
  }

  return new GoogleAuth({
    scopes: [...LIVE_GOOGLE_SCOPES],
  });
}

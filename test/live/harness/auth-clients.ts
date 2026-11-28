import type { GoogleAuth, OAuth2Client } from 'google-auth-library';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import { GoogleDriveClient } from '../../../src/infrastructure/drive/drive-client';
import { GoogleSheetsClient } from '../../../src/infrastructure/sheets';
import {
  getDocumentLogTestFolderId,
  getSubmittalCoverSheetTemplateId,
  hasLiveGoogleCredentials,
  loadEnvIfPresent,
  resolveLiveGoogleAuth,
} from '../../e2e/utils/live-google-auth';
import {
  DEFAULT_LIVE_RETRY_OPTIONS,
  createLiveSheetsApi,
  type LiveSheetsRetryOptions,
} from '../../e2e/utils/live-sheets-helper';

export {
  loadEnvIfPresent,
  getDocumentLogTestFolderId,
  getSubmittalCoverSheetTemplateId,
  hasLiveGoogleCredentials,
  resolveLiveGoogleAuth,
};

/**
 * Creates a retry-backed `GoogleDriveClient` authenticated via `resolveLiveGoogleAuth()`
 * (preserving `GOOGLE_APPLICATION_CREDENTIALS` / ADC fallback).
 */
export function createLiveDriveClient(
  auth?: OAuth2Client | GoogleAuth,
  retryOptions: LiveSheetsRetryOptions = DEFAULT_LIVE_RETRY_OPTIONS
): GoogleDriveClient {
  return new GoogleDriveClient({
    auth: auth ?? resolveLiveGoogleAuth(),
    retryOptions,
  });
}

/**
 * Creates both an authenticated `sheets_v4.Sheets` SDK instance and a retry-backed `GoogleSheetsClient`.
 */
export function createLiveSheetsClient(
  auth?: OAuth2Client | GoogleAuth,
  retryOptions: LiveSheetsRetryOptions = DEFAULT_LIVE_RETRY_OPTIONS
): {
  sheetsApi: sheets_v4.Sheets;
  sheetsClient: GoogleSheetsClient;
} {
  const resolvedAuth = auth ?? resolveLiveGoogleAuth();
  const sheetsApi = createLiveSheetsApi(resolvedAuth);
  const sheetsClient = new GoogleSheetsClient({
    sheets: sheetsApi,
    retryOptions,
  });
  return { sheetsApi, sheetsClient };
}

import type { GoogleAuth, OAuth2Client } from 'google-auth-library';
// nosemgrep: adapter-leakage-warning
import { google, type drive_v3, type sheets_v4 } from 'googleapis';
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
import {
  createApiCallTracker,
  diffApiCallCounts,
  type ApiCallCategoryCounts,
  type ApiCallCounts,
  type ApiCallTracker,
} from './api-counter';

export {
  loadEnvIfPresent,
  getDocumentLogTestFolderId,
  getSubmittalCoverSheetTemplateId,
  hasLiveGoogleCredentials,
  resolveLiveGoogleAuth,
  createApiCallTracker,
  diffApiCallCounts,
  type ApiCallCategoryCounts,
  type ApiCallCounts,
  type ApiCallTracker,
};

/**
 * Creates an authenticated `drive_v3.Drive` SDK instance.
 */
export function createLiveDriveApi(auth: OAuth2Client | GoogleAuth): drive_v3.Drive {
  return google.drive({
    version: 'v3',
    auth: auth as NonNullable<Parameters<typeof google.drive>[0]['auth']>,
  });
}

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
 * Creates a retry-backed `GoogleDriveClient` wired to an instrumented `drive_v3.Drive` SDK instance.
 */
export function createInstrumentedLiveDriveClient(
  auth?: OAuth2Client | GoogleAuth,
  retryOptions: LiveSheetsRetryOptions = DEFAULT_LIVE_RETRY_OPTIONS,
  tracker: ApiCallTracker = createApiCallTracker()
): {
  driveApi: drive_v3.Drive;
  driveClient: GoogleDriveClient;
  tracker: ApiCallTracker;
} {
  const resolvedAuth = auth ?? resolveLiveGoogleAuth();
  const driveApi = tracker.instrumentDriveApi(createLiveDriveApi(resolvedAuth));
  const driveClient = new GoogleDriveClient({
    drive: driveApi,
    retryOptions,
  });
  return { driveApi, driveClient, tracker };
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

/**
 * Creates an instrumented `sheets_v4.Sheets` SDK instance and a retry-backed `GoogleSheetsClient`.
 */
export function createInstrumentedLiveSheetsClient(
  auth?: OAuth2Client | GoogleAuth,
  retryOptions: LiveSheetsRetryOptions = DEFAULT_LIVE_RETRY_OPTIONS,
  tracker: ApiCallTracker = createApiCallTracker()
): {
  sheetsApi: sheets_v4.Sheets;
  sheetsClient: GoogleSheetsClient;
  tracker: ApiCallTracker;
} {
  const resolvedAuth = auth ?? resolveLiveGoogleAuth();
  const sheetsApi = tracker.instrumentSheetsApi(createLiveSheetsApi(resolvedAuth));
  const sheetsClient = new GoogleSheetsClient({
    sheets: sheetsApi,
    retryOptions,
  });
  return { sheetsApi, sheetsClient, tracker };
}

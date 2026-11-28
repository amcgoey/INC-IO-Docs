import type { LiveAppWiring, LiveAppWiringOptions } from './harness/app-wiring';
import * as authClients from './harness/auth-clients';
import * as cleanup from './harness/cleanup';
import * as sheetsHelpers from './harness/sheets-helpers';

export * from './harness/auth-clients';
export * from './harness/cleanup';
export * from './harness/sheets-helpers';
export type { LiveAppWiring, LiveAppWiringOptions } from './harness/app-wiring';

/**
 * Modular core `LiveTestHarness` facade for infrastructure and live Google suites.
 * Focused namespaces keep infrastructure suites decoupled from app/feature wiring.
 */
export const LiveTestHarness = {
  app: {
    DEFAULT_LIVE_LOOKUP_TIMEOUT_MS: 25_000,
    async createWiring(options?: LiveAppWiringOptions): Promise<LiveAppWiring> {
      const { createLiveAppWiring } = await import('./harness/app-wiring.js');
      return createLiveAppWiring(options);
    },
  },
  auth: {
    loadEnvIfPresent: authClients.loadEnvIfPresent,
    getDocumentLogTestFolderId: authClients.getDocumentLogTestFolderId,
    getSubmittalCoverSheetTemplateId: authClients.getSubmittalCoverSheetTemplateId,
    hasLiveGoogleCredentials: authClients.hasLiveGoogleCredentials,
    resolveLiveGoogleAuth: authClients.resolveLiveGoogleAuth,
  },
  clients: {
    createApiCallTracker: authClients.createApiCallTracker,
    createInstrumentedLiveDriveClient: authClients.createInstrumentedLiveDriveClient,
    createInstrumentedLiveSheetsClient: authClients.createInstrumentedLiveSheetsClient,
    createLiveDriveApi: authClients.createLiveDriveApi,
    createLiveDriveClient: authClients.createLiveDriveClient,
    createLiveSheetsApi: sheetsHelpers.createLiveSheetsApi,
    createLiveSheetsClient: authClients.createLiveSheetsClient,
    diffApiCallCounts: authClients.diffApiCallCounts,
    DEFAULT_LIVE_RETRY_OPTIONS: sheetsHelpers.DEFAULT_LIVE_RETRY_OPTIONS,
  },
  cleanup: {
    createCleanupTracker: cleanup.createCleanupTracker,
    cleanupScratchSpace: cleanup.cleanupScratchSpace,
  },
  sheets: {
    SHEET_ERROR_TOKENS: sheetsHelpers.SHEET_ERROR_TOKENS,
    appendRawPositiveTableRows: sheetsHelpers.appendRawPositiveTableRows,
    batchUpdateSpreadsheetValues: sheetsHelpers.batchUpdateSpreadsheetValues,
    buildPositiveTableTarget: sheetsHelpers.buildPositiveTableTarget,
    clearOptionTableToEmpty: sheetsHelpers.clearOptionTableToEmpty,
    ensureClearedPositiveTable: sheetsHelpers.ensureClearedPositiveTable,
    expectAliasesHeaderNote: sheetsHelpers.expectAliasesHeaderNote,
    findCleanDividerViolations: sheetsHelpers.findCleanDividerViolations,
    findSheetErrorTokens: sheetsHelpers.findSheetErrorTokens,
    findSideBySideTableShiftViolations: sheetsHelpers.findSideBySideTableShiftViolations,
    findSpreadsheetErrorTokens: sheetsHelpers.findSpreadsheetErrorTokens,
    inspectPositiveTableLayout: sheetsHelpers.inspectPositiveTableLayout,
    loadDocumentLogSampleFixture: sheetsHelpers.loadDocumentLogSampleFixture,
    partialHydrationRowToCellInputs: sheetsHelpers.partialHydrationRowToCellInputs,
    readNamedRangesFormattedValues: sheetsHelpers.readNamedRangesFormattedValues,
    readOptionTableGridFormats: sheetsHelpers.readOptionTableGridFormats,
    readSheetsGridLayout: sheetsHelpers.readSheetsGridLayout,
    readSpreadsheetMetadata: sheetsHelpers.readSpreadsheetMetadata,
    readSpreadsheetValues: sheetsHelpers.readSpreadsheetValues,
    snapshotNamedRanges: sheetsHelpers.snapshotNamedRanges,
    withLiveSheetsRetry: sheetsHelpers.withLiveSheetsRetry,
  },
} as const;

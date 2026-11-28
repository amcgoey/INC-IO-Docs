import * as authClients from './harness/auth-clients';
import * as cleanup from './harness/cleanup';
import * as sheetsHelpers from './harness/sheets-helpers';

export * from './harness/auth-clients';
export * from './harness/cleanup';
export * from './harness/sheets-helpers';

/**
 * Modular core `LiveTestHarness` facade for infrastructure and live Google suites.
 * Focused namespaces keep infrastructure suites decoupled from app/feature wiring.
 */
export const LiveTestHarness = {
  auth: {
    loadEnvIfPresent: authClients.loadEnvIfPresent,
    getDocumentLogTestFolderId: authClients.getDocumentLogTestFolderId,
    getSubmittalCoverSheetTemplateId: authClients.getSubmittalCoverSheetTemplateId,
    hasLiveGoogleCredentials: authClients.hasLiveGoogleCredentials,
    resolveLiveGoogleAuth: authClients.resolveLiveGoogleAuth,
  },
  clients: {
    createLiveDriveClient: authClients.createLiveDriveClient,
    createLiveSheetsApi: sheetsHelpers.createLiveSheetsApi,
    createLiveSheetsClient: authClients.createLiveSheetsClient,
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

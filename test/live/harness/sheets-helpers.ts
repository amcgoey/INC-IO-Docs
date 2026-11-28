import { expect } from 'vitest';
import type { PositiveTableTarget } from '../../../src/infrastructure/sheets';
export {
  DEFAULT_LIVE_RETRY_OPTIONS,
  SHEET_ERROR_TOKENS,
  appendRawPositiveTableRows,
  batchUpdateSpreadsheetValues,
  clearOptionTableToEmpty,
  clearOptionTablesToEmpty,
  createLiveSheetsApi,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSheetErrorTokens,
  findSideBySideTableShiftViolations,
  findSpreadsheetErrorTokens,
  inspectPositiveTableLayout,
  loadDocumentLogSampleFixture,
  partialHydrationRowToCellInputs,
  readMultiOptionTableGridFormats,
  readNamedRangesFormattedValues,
  readOptionTableGridFormats,
  readSheetsGridLayout,
  readSpreadsheetMetadata,
  readSpreadsheetValues,
  snapshotNamedRanges,
  withLiveSheetsRetry,
  type ClearOptionTableResult,
  type DocumentLogSampleFixture,
  type FixturePartialHydrationRow,
  type FixtureSubmittalEntry,
  type FixtureWriteScenario,
  type LiveSheetsRetryOptions,
  type MultiOptionTableGridFormatsResult,
  type NamedRangeSnapshot,
  type OptionTableGridFormatsInfo,
  type SpreadsheetErrorFinding,
} from '../../e2e/utils/live-sheets-helper';

/**
 * Builds a `PositiveTableTarget` with standard `<--->` extent and `---` divider markers.
 */
export function buildPositiveTableTarget(
  spreadsheetId: string,
  config: {
    sheetName: string;
    rangeName: string;
    extentMarker?: string;
    groupDividerMarker?: string;
  }
): PositiveTableTarget {
  return {
    spreadsheetId,
    sheetName: config.sheetName,
    rangeName: config.rangeName,
    extentMarker: config.extentMarker ?? '<--->',
    groupDividerMarker: config.groupDividerMarker ?? '---',
  };
}

/**
 * Verifies the `_Config` `Aliases` header note documents escaped quotes (`""`) and case-sensitivity.
 */
export function expectAliasesHeaderNote(note: string | undefined): void {
  expect(note?.trim().length).toBeGreaterThan(0);
  expect(note).toMatch(/""/);
  expect(note).toMatch(/case-?sensitiv/i);
}

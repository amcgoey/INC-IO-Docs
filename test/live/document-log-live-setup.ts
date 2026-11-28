import { PDFDocument } from 'pdf-lib';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from '@googleapis/sheets';
import type { CopyDocumentLogResult } from '../../src/features/document-log';
import {
  LiveTestHarness,
  type CleanupTracker,
  type LiveAppWiring,
} from './live-test-harness';

export const sampleFixture = LiveTestHarness.sheets.loadDocumentLogSampleFixture();
export const TEST_FOLDER_ID = LiveTestHarness.auth.getDocumentLogTestFolderId();

export interface ScratchSpaceProvisioning {
  spaceName: string;
  spaceFolderId: string;
  space: { id: string; typeId: string; name: string; abstractStorageId: string };
  copyResult: CopyDocumentLogResult;
  spreadsheetId: string;
  adminFolderId: string | undefined;
}

/**
 * Provisions an isolated scratch DocumentSpace folder and DocumentLog copy under `TEST_FOLDER_ID`,
 * registering the top-level folder, `"1 Admin"` subfolder, and spreadsheet with `tracker`.
 */
export async function provisionDocumentLogScratchSpace(params: {
  wiring: Pick<LiveAppWiring, 'driveClient' | 'logWiring'>;
  spaceName: string;
  spaceId: string;
  tracker: CleanupTracker;
}): Promise<ScratchSpaceProvisioning> {
  if (!TEST_FOLDER_ID) {
    throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live DocumentLog E2E tests.');
  }

  const { wiring, spaceName, spaceId, tracker } = params;
  const spaceFolder = await wiring.driveClient.findOrCreateFolder(TEST_FOLDER_ID, spaceName);
  tracker.trackFolder(spaceFolder.id);

  const space = {
    id: spaceId,
    typeId: 'proposals',
    name: spaceName,
    abstractStorageId: spaceFolder.id,
  };

  const copyResult = await wiring.logWiring.documentLogService.copyLog(space);
  const spreadsheetId = copyResult.candidate.id;
  let adminFolderId: string | undefined;
  const copiedParentId = copyResult.candidate.parents?.[0];
  if (copiedParentId && copiedParentId !== spaceFolder.id) {
    adminFolderId = copiedParentId;
  } else {
    try {
      const resolvedAdmin = await wiring.driveClient.resolveFolderPath(spaceFolder.id, ['1 Admin']);
      adminFolderId = resolvedAdmin.id;
    } catch {
      // Verified in test assertions; cleanupScratchSpace also performs best-effort discovery
    }
  }
  tracker.trackFolder(adminFolderId, spaceFolder.id);
  tracker.trackSpreadsheet(spreadsheetId, adminFolderId ?? spaceFolder.id);

  return {
    spaceName,
    spaceFolderId: spaceFolder.id,
    space,
    copyResult,
    spreadsheetId,
    adminFolderId,
  };
}

/**
 * Uploads a single-page PDF fixture into `targetFolderId` and registers it for cleanup.
 */
export async function uploadDummyPdf(params: {
  driveClient: LiveAppWiring['driveClient'];
  targetFolderId: string;
  fileName: string;
  textContent: string;
  tracker: CleanupTracker;
}): Promise<{ id: string; name: string }> {
  const { driveClient, targetFolderId, fileName, textContent, tracker } = params;
  const dummyPdfDoc = await PDFDocument.create();
  dummyPdfDoc.addPage([612, 792]).drawText(textContent);
  const dummyPdfBytes = Buffer.from(await dummyPdfDoc.save());

  const uploaded = await driveClient.saveBuffer(dummyPdfBytes, {
    action: 'create',
    name: fileName,
    targetFolderId,
    mimeType: 'application/pdf',
  });
  tracker.track(uploaded.id, { kind: 'file', parentFolderId: targetFolderId });
  return { id: uploaded.id, name: fileName };
}

/**
 * Extracts cell data for a 0-based absolute row index from a `Spreadsheet` returned with `GridData`.
 */
export function getRowCellsFromSpreadsheetGrid(
  spreadsheet: sheets_v4.Schema$Spreadsheet,
  sheetTitle: string,
  absRowIndex: number
): sheets_v4.Schema$CellData[] {
  const sheet = (spreadsheet.sheets ?? []).find(
    (s) => s.properties?.title?.toLowerCase() === sheetTitle.toLowerCase()
  );
  for (const gridData of sheet?.data ?? []) {
    const baseRow = gridData.startRow ?? 0;
    const rowData = gridData.rowData ?? [];
    if (absRowIndex >= baseRow && absRowIndex < baseRow + rowData.length) {
      return rowData[absRowIndex - baseRow]?.values ?? [];
    }
  }
  return [];
}

/**
 * Scans all `GridData` sheets in an already-fetched `Schema$Spreadsheet` for Sheets error tokens
 * (`#REF!`, `#ERROR!`, `#N/A`, `#VALUE!`, `#NAME?`, `#DIV/0!`) without issuing additional API reads.
 */
export function findGridErrorTokens(spreadsheet: sheets_v4.Schema$Spreadsheet): Array<{
  sheetTitle: string;
  rowNumber: number;
  columnIndex: number;
  value: string;
  tokens: string[];
}> {
  const findings: Array<{
    sheetTitle: string;
    rowNumber: number;
    columnIndex: number;
    value: string;
    tokens: string[];
  }> = [];

  for (const sheet of spreadsheet.sheets ?? []) {
    const sheetTitle = sheet.properties?.title ?? '';
    for (const gridData of sheet.data ?? []) {
      const baseRow = gridData.startRow ?? 0;
      const baseCol = gridData.startColumn ?? 0;
      (gridData.rowData ?? []).forEach((row, rowOffset) => {
        (row.values ?? []).forEach((cell, colOffset) => {
          const val = cell.formattedValue;
          if (typeof val !== 'string' || val.length === 0) {
            return;
          }
          const tokens = LiveTestHarness.sheets.SHEET_ERROR_TOKENS.filter((token) =>
            val.includes(token)
          );
          if (tokens.length > 0) {
            findings.push({
              sheetTitle,
              rowNumber: baseRow + rowOffset + 1,
              columnIndex: baseCol + colOffset,
              value: val,
              tokens,
            });
          }
        });
      });
    }
  }

  return findings;
}

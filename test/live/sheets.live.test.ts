import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import type { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import {
  GoogleSheetsClient,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
  type PositiveTableTarget,
  type RowKey,
  type RowRecord,
  type SheetCellInput,
} from '../../src/infrastructure/sheets';
import { LiveTestHarness, type FixtureSubmittalEntry } from './live-test-harness';

const sampleFixture = LiveTestHarness.sheets.loadDocumentLogSampleFixture();
const TEST_FOLDER_ID = LiveTestHarness.auth.getDocumentLogTestFolderId();

const ACTION_NAME_TO_ORDER: Record<string, string> = {
  Received: '1',
  Referred: '2',
  'Not Reviewed': '3',
  Rejected: '4',
  'Revise & Resubmit': '5',
  'No Objections As Corrected': '6',
  'No Exceptions Taken': '7',
};

function createGroupedRowKeyExtractor(config: {
  getGroupKey: (row: RowRecord) => string | null;
  getSortKeyParts: (row: RowRecord) => string[];
}): (row: RowRecord) => RowKey | null {
  return (row: RowRecord): RowKey | null => {
    const groupKey = config.getGroupKey(row);
    if (!groupKey) {
      return null;
    }
    const actionName = String(row.Action ?? '').trim();
    const actionOrder = ACTION_NAME_TO_ORDER[actionName] ?? actionName;
    return {
      groupKey,
      sortKey: [...config.getSortKeyParts(row), actionOrder].join('-'),
    };
  };
}

const extractArchRowKeys = createGroupedRowKeyExtractor({
  getGroupKey: (row) => {
    const section = String(row.Section ?? '').trim();
    const number = String(row.Number ?? '').trim();
    return section || number ? `${section}-${number}` : null;
  },
  getSortKeyParts: (row) => [
    String(row.Section ?? '').trim(),
    String(row.Number ?? '').trim(),
    String(row.Revision ?? '').trim(),
    String(row.Date ?? '').trim(),
  ],
});

const extractFfeRowKeys = createGroupedRowKeyExtractor({
  getGroupKey: (row) => String(row['Spec Tag'] ?? '').trim() || null,
  getSortKeyParts: (row) => [
    String(row['Spec Tag'] ?? '').trim(),
    String(row.Revision ?? '').trim(),
    String(row.Date ?? '').trim(),
  ],
});

function buildArchRowData(entry: FixtureSubmittalEntry): Record<string, SheetCellInput> {
  const d = entry.documentData;
  return {
    Status: d.status,
    Section: d.section,
    Number: d.number,
    Revision: d.revision,
    Title: d.title,
    Date: d.date,
    Contact: d.contact,
    Action: entry.actionName,
    Notes: d.notes === '' ? null : d.notes,
    'Calc Link': entry.fileUri
      ? { formula: `=HYPERLINK("${entry.fileUri}", "Link")` }
      : null,
  };
}

function buildFfeRowData(
  entry: FixtureSubmittalEntry,
  overrides?: Partial<{ actionName: string; fileUri: string | null; relatedTag: string | null }>
): Record<string, SheetCellInput> {
  const d = entry.documentData;
  const effectiveUri = overrides && 'fileUri' in overrides ? overrides.fileUri : entry.fileUri;
  const effectiveRelated =
    overrides && 'relatedTag' in overrides
      ? overrides.relatedTag
      : d.relatedTag === ''
        ? null
        : d.relatedTag;
  return {
    Status: d.status,
    'Spec Tag': d.specTag,
    'Related Tag': effectiveRelated,
    Revision: d.revision,
    Vendor: d.vendor,
    Date: d.date,
    Contact: d.contact,
    Action: overrides?.actionName ?? entry.actionName,
    Notes: d.notes === '' ? null : d.notes,
    'Calc Link': effectiveUri ? { formula: `=HYPERLINK("${effectiveUri}", "Link")` } : null,
  };
}

function getRowValuesFromSheetGrid(
  spreadsheet: sheets_v4.Schema$Spreadsheet,
  sheetTitle: string,
  absRowIndex: number
): sheets_v4.Schema$CellData[] {
  const sheet = (spreadsheet.sheets ?? []).find(
    (s) => s.properties?.title?.toLowerCase() === sheetTitle.toLowerCase()
  );
  const gridData = sheet?.data?.[0];
  const baseRow = gridData?.startRow ?? 0;
  const relRow = absRowIndex - baseRow;
  return gridData?.rowData?.[relRow]?.values ?? [];
}

describe.skipIf(!TEST_FOLDER_ID)('Live Google Sheets Infrastructure Contract Tracer Bullets', () => {
  const cleanupTracker = LiveTestHarness.cleanup.createCleanupTracker();
  let driveClient: GoogleDriveClient | undefined;
  let sheetsApi: sheets_v4.Sheets;
  let sheetsClient: GoogleSheetsClient;
  let copiedSpreadsheetId: string | undefined;

  const requireSpreadsheetId = (): string => {
    if (!copiedSpreadsheetId) {
      throw new Error('Copied test spreadsheet ID is not initialized.');
    }
    return copiedSpreadsheetId;
  };

  const archTarget = (): PositiveTableTarget =>
    LiveTestHarness.sheets.buildPositiveTableTarget(requireSpreadsheetId(), sampleFixture.submittalArch);

  const ffeTarget = (): PositiveTableTarget =>
    LiveTestHarness.sheets.buildPositiveTableTarget(requireSpreadsheetId(), sampleFixture.submittalFfe);

  beforeAll(async () => {
    if (!TEST_FOLDER_ID) {
      throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live Google Sheets tests.');
    }
    const auth = LiveTestHarness.auth.resolveLiveGoogleAuth();
    driveClient = LiveTestHarness.clients.createLiveDriveClient(auth);
    const createdSheets = LiveTestHarness.clients.createLiveSheetsClient(auth);
    sheetsApi = createdSheets.sheetsApi;
    sheetsClient = createdSheets.sheetsClient;

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const copied = await driveClient.duplicate(sampleFixture.metadata.templateSpreadsheetId, {
      newName: `INC Sheets Live Test ${runId}`,
      targetFolderId: TEST_FOLDER_ID,
    });
    copiedSpreadsheetId = copied.id;
    cleanupTracker.trackSpreadsheet(copied.id);

    await LiveTestHarness.sheets.ensureClearedPositiveTable(sheetsApi, archTarget());
    await LiveTestHarness.sheets.ensureClearedPositiveTable(sheetsApi, ffeTarget());
  }, 60_000);

  afterAll(async () => {
    if (driveClient) {
      await cleanupTracker.trashAll(driveClient);
    }
  }, 90_000);

  it('maps missing named range and missing column errors from real Google Sheets', async () => {
    await expect(
      sheetsClient.readTable({
        target: {
          ...archTarget(),
          rangeName: 'NonExistentNamedRange_XYZ_123',
        },
      })
    ).rejects.toThrow(GoogleSheetsNamedRangeNotFoundError);

    await expect(
      sheetsClient.insertIntoGroupedList({
        target: archTarget(),
        rowData: { NonExistentColumn_XYZ_123: 'anything' },
      })
    ).rejects.toThrow(GoogleSheetsColumnNotFoundError);
  });

  it('verifies cleared placeholder, =HYPERLINK, literal =text, leading zeros, and multi-group mid-table clean dividers on Submittal Arch', async () => {
    const target = archTarget();
    const initial = await sheetsClient.readTable({ target });
    expect(initial.rows).toEqual([]);

    const concreteSeed = sampleFixture.submittalArch.seedEntries[0]; // 033000-001
    const waterproofingSeed = sampleFixture.submittalArch.seedEntries[2]; // 071200-001

    // 1) Insert first group on cleared placeholder
    const firstInsert = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: buildArchRowData(concreteSeed),
      rowKeyExtractor: extractArchRowKeys,
      targetKeys: {
        groupKey: concreteSeed.identity.idGroup,
        sortKey: concreteSeed.identity.id,
      },
    });
    expect(firstInsert).toEqual({
      rowNumber: 6,
      action: 'inserted',
      sheetId: expect.any(Number),
    });
    expect(Number.isInteger(firstInsert.sheetId) && (firstInsert.sheetId ?? -1) >= 0).toBe(true);

    // 2) Insert bottom group with literal =text strings (must stay stringValue, never evaluated)
    const literalInsert = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: {
        Status: 'Open',
        Section: '099000',
        Number: '001',
        Revision: '0',
        Title: '=SUM(1,2)',
        Date: '260325',
        Contact: 'MB',
        Action: 'Received',
        Notes: '=1+1',
        'Calc Link': null,
      },
      rowKeyExtractor: extractArchRowKeys,
      targetKeys: {
        groupKey: '099000-001',
        sortKey: '099000-001-0-260325-1',
      },
    });
    expect(literalInsert.action).toBe('inserted');

    // 3) Insert mid-table group between 033000-001 and 099000-001
    const midInsert = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: buildArchRowData(waterproofingSeed),
      rowKeyExtractor: extractArchRowKeys,
      targetKeys: {
        groupKey: waterproofingSeed.identity.idGroup,
        sortKey: waterproofingSeed.identity.id,
      },
    });
    expect(midInsert.action).toBe('inserted');

    const layout = await LiveTestHarness.sheets.inspectPositiveTableLayout(sheetsApi, target);
    const dataRows = layout.betweenRows.filter((row) => row.kind === 'data');
    expect(dataRows).toHaveLength(3);

    const sectionCol = layout.headers.indexOf('Section');
    const numberCol = layout.headers.indexOf('Number');
    const titleCol = layout.headers.indexOf('Title');
    const notesCol = layout.headers.indexOf('Notes');
    const linkCol = layout.headers.indexOf('Calc Link');

    expect(
      dataRows.map((row) => `${row.formattedRow[sectionCol]}-${row.formattedRow[numberCol]}`)
    ).toEqual(['033000-001', '071200-001', '099000-001']);

    // Literal =text preserved as string (both formatted display and raw value)
    expect(dataRows[2].formattedRow[titleCol]).toBe('=SUM(1,2)');
    expect(dataRows[2].formattedRow[notesCol]).toBe('=1+1');
    expect(layout.formulaRowsByHeader.Title[2]).toBe('=SUM(1,2)');
    expect(layout.formulaRowsByHeader.Notes[2]).toBe('=1+1');

    // =HYPERLINK on seeded rows, blank on null Calc Link row
    expect(dataRows[0].formattedRow[linkCol]).toBe('Link');
    expect(dataRows[1].formattedRow[linkCol]).toBe('Link');
    expect(layout.formulaRowsByHeader['Calc Link']).toEqual([
      `=HYPERLINK("${concreteSeed.fileUri}", "Link")`,
      `=HYPERLINK("${waterproofingSeed.fileUri}", "Link")`,
      '',
    ]);

    expect(
      LiveTestHarness.sheets.findCleanDividerViolations({
        ...layout,
        expectedDividerCount: 2,
      })
    ).toEqual([]);
  }, 60_000);

  it('verifies grouped insertion/ordering, ARRAYFORMULA Spec Title, and optional blank Related Tag on Submittal FF&E', async () => {
    const target = ffeTarget();
    const cg104Seed = sampleFixture.submittalFfe.seedEntries[0]; // CG104 with Related Tag FB127
    const fb127Seed = sampleFixture.submittalFfe.seedEntries[3]; // FB127 with blank Related Tag

    const firstInsert = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: buildFfeRowData(cg104Seed, { actionName: 'Revise & Resubmit' }),
      rowKeyExtractor: extractFfeRowKeys,
      targetKeys: {
        groupKey: cg104Seed.identity.idGroup,
        sortKey: 'CG104-0-260120-5',
      },
      readOnlyColumns: ['Spec Title'],
    });
    expect(firstInsert).toEqual({
      rowNumber: 6,
      action: 'inserted',
      sheetId: expect.any(Number),
    });

    const secondInsert = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: buildFfeRowData(fb127Seed, { fileUri: null }),
      rowKeyExtractor: extractFfeRowKeys,
      targetKeys: {
        groupKey: fb127Seed.identity.idGroup,
        sortKey: fb127Seed.identity.id,
      },
      readOnlyColumns: ['Spec Title'],
    });
    expect(secondInsert.action).toBe('inserted');

    const table = await sheetsClient.readTable({ target });
    expect(table.formulaColumns).toEqual(['Spec Title']);
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.values['Spec Tag'])).toEqual(['CG104', 'FB127']);
    expect(table.rows[0].values['Related Tag']).toBe('FB127');
    expect(table.rows[0].values['Spec Title']).toBe('BED - KING');
    expect(table.rows[1].values['Related Tag'] || '').toBe('');
    expect(table.rows[1].values['Spec Title']).toBe('FABRIC - LEATHER');
    expect(table.rows[1].values['Calc Link'] || '').toBe('');

    for (const row of table.rows) {
      expect(LiveTestHarness.sheets.findSheetErrorTokens(row.values)).toEqual([]);
    }
  }, 60_000);

  it('verifies Calc File Name shifted VLOOKUP, FF&E divider, _Config table offsets / Row 2 merges / Aliases notes, and zero error tokens', async () => {
    const spreadsheetId = requireSpreadsheetId();
    const grid = await LiveTestHarness.sheets.readSheetsGridLayout(sheetsApi, spreadsheetId, [
      `'${sampleFixture.submittalFfe.sheetName}'!A4:L8`,
      "'_Config Submittal Arch'!A1:K4",
      "'_Config Submittal FF&E'!A1:P4",
    ]);

    // 1) Submittal FF&E Row 4 ARRAYFORMULA & Calc File Name shifted VLOOKUP + Row 6 Calc File Name + Row 7 clean divider
    const ffeRow4 = getRowValuesFromSheetGrid(grid, sampleFixture.submittalFfe.sheetName, 3);
    expect(ffeRow4[4]?.userEnteredValue?.formulaValue).toBe(
      '=ARRAYFORMULA(IFERROR(VLOOKUP(B4:B,Options_Submittal_FFE_Specs,2,FALSE)))'
    );
    expect(ffeRow4[11]?.userEnteredValue?.formulaValue).toContain("'_Config Submittal FF&E'!H4:I");

    const ffeRow6 = getRowValuesFromSheetGrid(grid, sampleFixture.submittalFfe.sheetName, 5);
    expect(ffeRow6[10]?.userEnteredValue?.formulaValue).toBe(
      `=HYPERLINK("${sampleFixture.submittalFfe.seedEntries[0].fileUri}", "Link")`
    );
    expect(ffeRow6[11]?.formattedValue).toBe('CG104-0 Keystone Casegoods - 260120 HPG_RR');

    const ffeDividerRow = getRowValuesFromSheetGrid(grid, sampleFixture.submittalFfe.sheetName, 6);
    expect(ffeDividerRow[0]?.formattedValue).toBe('---');
    expect(ffeDividerRow.slice(1).every((cell) => !(cell.formattedValue ?? '').trim())).toBe(true);

    // 2) _Config Submittal Arch table offset, Row 1/2 merges, Row 3 headers & Aliases note
    const archConfigSheet = (grid.sheets ?? []).find(
      (s) => s.properties?.title === '_Config Submittal Arch'
    );
    expect(archConfigSheet?.merges).toContainEqual(
      expect.objectContaining({
        startRowIndex: 1,
        endRowIndex: 2,
        startColumnIndex: 5,
        endColumnIndex: 9,
      })
    );
    const archContactsRange = (grid.namedRanges ?? []).find(
      (nr) => nr.name === 'Options_Submittal_Arch_Contacts'
    );
    expect(archContactsRange?.range).toMatchObject({
      startRowIndex: 2,
      startColumnIndex: 5,
      endColumnIndex: 9,
    });
    const archConfigRow1 = getRowValuesFromSheetGrid(grid, '_Config Submittal Arch', 0);
    const archConfigRow2 = getRowValuesFromSheetGrid(grid, '_Config Submittal Arch', 1);
    const archConfigRow3 = getRowValuesFromSheetGrid(grid, '_Config Submittal Arch', 2);
    expect(archConfigRow1[0]?.formattedValue).toBe('Architecture Submittal Log Settings');
    expect(archConfigRow2.map((c) => (c.formattedValue ?? '').trim())).toContain(
      'Specification Divisions'
    );
    expect(archConfigRow3.slice(5, 9).map((c) => (c.formattedValue ?? '').trim())).toEqual([
      'Type',
      'Key',
      'Name',
      'Aliases',
    ]);
    LiveTestHarness.sheets.expectAliasesHeaderNote(archConfigRow3[8]?.note ?? undefined);

    // 3) _Config Submittal FF&E table offsets, Row 2 merges, Row 3 headers & Aliases notes
    const ffeConfigSheet = (grid.sheets ?? []).find(
      (s) => s.properties?.title === '_Config Submittal FF&E'
    );
    expect(ffeConfigSheet?.merges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 0,
          endColumnIndex: 3,
        }),
        expect.objectContaining({
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 3,
          endColumnIndex: 7,
        }),
        expect.objectContaining({
          startRowIndex: 1,
          endRowIndex: 2,
          startColumnIndex: 12,
          endColumnIndex: 16,
        }),
      ])
    );
    const namedRangeByName = new Map((grid.namedRanges ?? []).map((nr) => [nr.name, nr.range]));
    expect(namedRangeByName.get('Options_Submittal_FFE_Specs')).toMatchObject({
      startRowIndex: 2,
      startColumnIndex: 0,
      endColumnIndex: 3,
    });
    expect(namedRangeByName.get('Options_Submittal_FFE_Vendors')).toMatchObject({
      startRowIndex: 2,
      startColumnIndex: 3,
      endColumnIndex: 7,
    });
    expect(namedRangeByName.get('Options_Submittal_FFE_Contacts')).toMatchObject({
      startRowIndex: 2,
      startColumnIndex: 12,
      endColumnIndex: 16,
    });

    const ffeConfigRow3 = getRowValuesFromSheetGrid(grid, '_Config Submittal FF&E', 2);
    expect(ffeConfigRow3.slice(0, 3).map((c) => (c.formattedValue ?? '').trim())).toEqual([
      'Tag',
      'Title',
      'Aliases',
    ]);
    LiveTestHarness.sheets.expectAliasesHeaderNote(ffeConfigRow3[2]?.note ?? undefined);
    expect(ffeConfigRow3.slice(3, 7).map((c) => (c.formattedValue ?? '').trim())).toEqual([
      'Type',
      'Key',
      'Name',
      'Aliases',
    ]);
    LiveTestHarness.sheets.expectAliasesHeaderNote(ffeConfigRow3[6]?.note ?? undefined);
    expect(ffeConfigRow3.slice(12, 16).map((c) => (c.formattedValue ?? '').trim())).toEqual([
      'Type',
      'Key',
      'Name',
      'Aliases',
    ]);
    LiveTestHarness.sheets.expectAliasesHeaderNote(ffeConfigRow3[15]?.note ?? undefined);

    // 4) Full-workbook spreadsheet error-token scan (#REF!, #ERROR!, #N/A, #VALUE!, #NAME?, #DIV/0!)
    expect(
      await LiveTestHarness.sheets.findSpreadsheetErrorTokens(
        sheetsApi,
        spreadsheetId,
        LiveTestHarness.clients.DEFAULT_LIVE_RETRY_OPTIONS
      )
    ).toEqual([]);
  }, 60_000);
});

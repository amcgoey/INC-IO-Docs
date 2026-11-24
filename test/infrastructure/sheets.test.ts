import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import {
  GoogleSheetsClient,
  GoogleSheetsColumnNotFoundError,
  GoogleSheetsNamedRangeNotFoundError,
  type InsertGroupedRowResult,
  type PositiveTableTarget,
  type RowKey,
  type RowRecord,
  type SheetCellInput,
} from '../../src/infrastructure/sheets';
import {
  getDocumentLogTestFolderId,
  resolveLiveGoogleAuth,
} from '../e2e/utils/live-google-auth';
import {
  DEFAULT_LIVE_RETRY_OPTIONS,
  createLiveSheetsApi,
  ensureClearedPositiveTable,
  findCleanDividerViolations,
  findSheetErrorTokens,
  inspectPositiveTableLayout,
  loadDocumentLogSampleFixture,
  type FixtureSubmittalEntry,
  type FixtureWriteScenario,
} from '../e2e/utils/live-sheets-helper';

const sampleFixture = loadDocumentLogSampleFixture();

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

function buildFfeRowData(entry: FixtureSubmittalEntry): Record<string, SheetCellInput> {
  const d = entry.documentData;
  return {
    Status: d.status,
    'Spec Tag': d.specTag,
    'Related Tag': d.relatedTag === '' ? null : d.relatedTag,
    Revision: d.revision,
    Vendor: d.vendor,
    Date: d.date,
    Contact: d.contact,
    Action: entry.actionName,
    Notes: d.notes === '' ? null : d.notes,
    'Calc Link': entry.fileUri
      ? { formula: `=HYPERLINK("${entry.fileUri}", "Link")` }
      : null,
  };
}

async function insertEntries(params: {
  sheetsClient: GoogleSheetsClient;
  target: PositiveTableTarget;
  entries: readonly FixtureSubmittalEntry[];
  buildRowData: (entry: FixtureSubmittalEntry) => Record<string, SheetCellInput>;
  rowKeyExtractor: (row: RowRecord) => RowKey | null;
  readOnlyColumns?: string[];
}): Promise<InsertGroupedRowResult[]> {
  const { sheetsClient, target, entries, buildRowData, rowKeyExtractor, readOnlyColumns } = params;
  const results: InsertGroupedRowResult[] = [];

  for (const entry of entries) {
    const result = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: buildRowData(entry),
      rowKeyExtractor,
      targetKeys: {
        groupKey: entry.identity.idGroup,
        sortKey: entry.identity.id,
      },
      duplicatePolicy: 'insert',
      ...(readOnlyColumns !== undefined ? { readOnlyColumns } : {}),
    });
    expect(result.action).toBe('inserted');
    results.push(result);
  }

  return results;
}

const TEST_FOLDER_ID = getDocumentLogTestFolderId();

describe.skipIf(!TEST_FOLDER_ID)('Live Google Sheets Integration Tests (Copy-and-Trash)', () => {
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

  const archTarget = (): PositiveTableTarget => ({
    spreadsheetId: requireSpreadsheetId(),
    sheetName: sampleFixture.submittalArch.sheetName,
    rangeName: sampleFixture.submittalArch.rangeName,
    extentMarker: '<--->',
    groupDividerMarker: '---',
  });

  const ffeTarget = (): PositiveTableTarget => ({
    spreadsheetId: requireSpreadsheetId(),
    sheetName: sampleFixture.submittalFfe.sheetName,
    rangeName: sampleFixture.submittalFfe.rangeName,
    extentMarker: '<--->',
    groupDividerMarker: '---',
  });

  beforeAll(async () => {
    if (!TEST_FOLDER_ID) {
      throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live Google Sheets tests.');
    }
    const auth = resolveLiveGoogleAuth();
    driveClient = new GoogleDriveClient({ auth, retryOptions: DEFAULT_LIVE_RETRY_OPTIONS });
    sheetsApi = createLiveSheetsApi(auth);
    sheetsClient = new GoogleSheetsClient({
      sheets: sheetsApi,
      retryOptions: DEFAULT_LIVE_RETRY_OPTIONS,
    });

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const copied = await driveClient.duplicate(sampleFixture.metadata.templateSpreadsheetId, {
      newName: `INC Sheets Live Test ${runId}`,
      targetFolderId: TEST_FOLDER_ID,
    });
    copiedSpreadsheetId = copied.id;

    await ensureClearedPositiveTable(sheetsApi, archTarget());
    await ensureClearedPositiveTable(sheetsApi, ffeTarget());
  }, 60_000);

  afterAll(async () => {
    if (driveClient && copiedSpreadsheetId) {
      await driveClient.trash(copiedSpreadsheetId);
    }
  }, 90_000);

  it('throws GoogleSheetsNamedRangeNotFoundError and GoogleSheetsColumnNotFoundError for invalid targets', async () => {
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

  it('preserves empty cleared template placeholder, leading zeros, and =HYPERLINK on Submittal Arch', async () => {
    const target = archTarget();
    const initial = await sheetsClient.readTable({ target });
    expect(initial.rows).toEqual([]);

    const firstSeed = sampleFixture.submittalArch.seedEntries[0];
    const insertResult = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: buildArchRowData(firstSeed),
      rowKeyExtractor: extractArchRowKeys,
      targetKeys: {
        groupKey: firstSeed.identity.idGroup,
        sortKey: firstSeed.identity.id,
      },
    });

    expect(insertResult).toEqual({
      rowNumber: 6,
      action: 'inserted',
    });

    const after = await sheetsClient.readTable({ target });
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0].rowNumber).toBe(6);
    expect(after.rows[0].values).toMatchObject({
      Status: 'Closed',
      Section: '033000',
      Number: '001',
      Revision: '0',
      Title: 'Cast-in-Place Concrete Mix Design',
      Date: '260115',
      Contact: 'MB',
      Action: 'Received',
      Notes: '4000 psi podium slab mix',
      'Calc Link': 'Link',
    });

    const layout = await inspectPositiveTableLayout(sheetsApi, target);
    expect(layout.formulaRowsByHeader['Calc Link']).toEqual([
      `=HYPERLINK("${firstSeed.fileUri}", "Link")`,
    ]);
  }, 60_000);

  it('seeds remaining Submittal Arch entries and executes all 5 grouped writeScenarios cleanly', async () => {
    const target = archTarget();

    await insertEntries({
      sheetsClient,
      target,
      entries: sampleFixture.submittalArch.seedEntries.slice(1),
      buildRowData: buildArchRowData,
      rowKeyExtractor: extractArchRowKeys,
    });

    const writeScenarios: readonly FixtureWriteScenario[] = sampleFixture.submittalArch.writeScenarios;
    const scenarioResults = await insertEntries({
      sheetsClient,
      target,
      entries: writeScenarios,
      buildRowData: buildArchRowData,
      rowKeyExtractor: extractArchRowKeys,
    });

    expect(scenarioResults[0]).toEqual({
      rowNumber: 6,
      action: 'inserted',
    });

    const table = await sheetsClient.readTable({ target });
    expect(table.rows).toHaveLength(16);

    const actualOrder = table.rows.map(
      (r) =>
        `${r.values.Section}-${r.values.Number}-${r.values.Revision}-${r.values.Date}-${r.values.Contact}`
    );
    expect(actualOrder).toEqual([
      '013300-001-0-260110-MB',
      '033000-001-0-260115-MB',
      '033000-001-0-260122-ARC',
      '071200-001-0-260204-MB',
      '071200-001-0-260205-PST',
      '071200-001-0-260205-SME',
      '071200-001-0-260205-LMD',
      '071200-001-0-260212-ARC',
      '071200-001-1-260220-MB',
      '071200-001-1-260224-ARC',
      '071200-002-0-260218-MB',
      '071200-002-0-260219-PST',
      '075100-001-0-260220-MB',
      '087100-001-0-260303-MB',
      '087100-001-0-260305-ARC',
      '096500-001-0-260314-MB',
    ]);

    const waterproofStart = table.rows.find(
      (r) => r.values.Section === '071200' && r.values.Number === '001' && r.values.Date === '260204'
    );
    expect(waterproofStart?.values).toMatchObject({
      Section: '071200',
      Number: '001',
    });

    const nullUriRowIndex = table.rows.findIndex(
      (r) => r.values.Section === '071200' && r.values.Number === '002' && r.values.Date === '260219'
    );
    expect(nullUriRowIndex).toBeGreaterThan(-1);
    expect(table.rows[nullUriRowIndex].values['Calc Link'] || '').toBe('');

    const layout = await inspectPositiveTableLayout(sheetsApi, target);
    expect(layout.formulaRowsByHeader['Calc Link']).toHaveLength(16);
    expect(layout.formulaRowsByHeader['Calc Link'][nullUriRowIndex]).toBe('');
    for (let i = 0; i < 16; i++) {
      if (i !== nullUriRowIndex) {
        expect(table.rows[i].values['Calc Link']).toBe('Link');
        expect(layout.formulaRowsByHeader['Calc Link'][i]).toMatch(
          /^=HYPERLINK\("https:\/\/drive\.google\.com\/file\/d\/.+", "Link"\)$/
        );
      }
    }

    expect(
      findCleanDividerViolations({
        ...layout,
        expectedDividerCount: 6,
      })
    ).toEqual([]);
  }, 180_000);

  it('writes literal =text safely as stringValue without formula evaluation on Submittal Arch', async () => {
    const target = archTarget();
    const insertResult = await sheetsClient.insertIntoGroupedList({
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

    expect(insertResult.action).toBe('inserted');

    const table = await sheetsClient.readTable({ target });
    const rowIdx = table.rows.findIndex((r) => r.values.Section === '099000');
    expect(rowIdx).toBeGreaterThan(-1);
    expect(table.rows[rowIdx].values.Title).toBe('=SUM(1,2)');
    expect(table.rows[rowIdx].values.Notes).toBe('=1+1');

    const layout = await inspectPositiveTableLayout(sheetsApi, target);
    expect(layout.formulaRowsByHeader.Title[rowIdx]).toBe('=SUM(1,2)');
    expect(layout.formulaRowsByHeader.Notes[rowIdx]).toBe('=1+1');
  }, 60_000);

  it('preserves Spec Title ARRAYFORMULA, optional blank Related Tag, and layout on Submittal FF&E', async () => {
    const target = ffeTarget();
    const initial = await sheetsClient.readTable({ target });
    expect(initial.formulaColumns).toEqual(['Spec Title']);
    expect(initial.rows).toEqual([]);

    const firstSeed = sampleFixture.submittalFfe.seedEntries[0];
    const firstInsert = await sheetsClient.insertIntoGroupedList({
      target,
      rowData: buildFfeRowData(firstSeed),
      rowKeyExtractor: extractFfeRowKeys,
      targetKeys: {
        groupKey: firstSeed.identity.idGroup,
        sortKey: firstSeed.identity.id,
      },
      readOnlyColumns: ['Spec Title'],
    });
    expect(firstInsert).toEqual({
      rowNumber: 6,
      action: 'inserted',
    });

    const afterFirst = await sheetsClient.readTable({ target });
    expect(afterFirst.rows).toHaveLength(1);
    expect(afterFirst.rows[0].values['Spec Title']).toBe('BED - KING');

    await insertEntries({
      sheetsClient,
      target,
      entries: [
        ...sampleFixture.submittalFfe.seedEntries.slice(1),
        ...sampleFixture.submittalFfe.writeScenarios,
      ],
      buildRowData: buildFfeRowData,
      rowKeyExtractor: extractFfeRowKeys,
      readOnlyColumns: ['Spec Title'],
    });

    const table = await sheetsClient.readTable({ target });
    expect(table.formulaColumns).toEqual(['Spec Title']);
    expect(table.rows).toHaveLength(12);

    const actualOrder = table.rows.map(
      (r) =>
        `${r.values['Spec Tag']}-${r.values.Revision}-${r.values.Date}-${r.values.Contact}|${r.values['Related Tag'] ?? ''}`
    );
    expect(actualOrder).toEqual([
      'AC102-0-260112-HPG|',
      'CG104-0-260120-HPG|FB127',
      'CG104-0-260128-ARC|FB127',
      'CG104-1-260205-HPG|FB127',
      'CG104-1-260210-ARC|FB127',
      'CP119-0-260201-HPG|',
      'FB127-0-260118-HPG|',
      'FB127-0-260125-ARC|',
      'LT108-0-260214-HPG|',
      'LT108-0-260215-LMD|',
      'LT108-0-260215-OBR|',
      'TA139-0-260301-ARC|',
    ]);

    const expectedSpecTitles: Record<string, string> = {
      AC102: 'HOOK',
      CG104: 'BED - KING',
      CP119: 'CARPET',
      FB127: 'FABRIC - LEATHER',
      LT108: 'SCONCE',
      TA139: 'TABLE - WORK',
    };

    for (const row of table.rows) {
      const specTag = String(row.values['Spec Tag'] ?? '');
      expect(row.values['Spec Title']).toBe(expectedSpecTitles[specTag]);
      expect(findSheetErrorTokens(row.values)).toEqual([]);
    }

    const nullUriRowIndex = table.rows.findIndex(
      (r) => r.values['Spec Tag'] === 'LT108' && r.values.Contact === 'OBR'
    );
    expect(nullUriRowIndex).toBeGreaterThan(-1);
    expect(table.rows[nullUriRowIndex].values['Calc Link'] || '').toBe('');

    const layout = await inspectPositiveTableLayout(sheetsApi, target);
    expect(layout.formulaRowsByHeader['Calc Link']).toHaveLength(12);
    expect(layout.formulaRowsByHeader['Calc Link'][nullUriRowIndex]).toBe('');
    for (let i = 0; i < 12; i++) {
      if (i !== nullUriRowIndex) {
        expect(table.rows[i].values['Calc Link']).toBe('Link');
        expect(layout.formulaRowsByHeader['Calc Link'][i]).toMatch(
          /^=HYPERLINK\("https:\/\/drive\.google\.com\/file\/d\/.+", "Link"\)$/
        );
      }
    }

    expect(
      findCleanDividerViolations({
        ...layout,
        expectedDividerCount: 5,
      })
    ).toEqual([]);
  }, 180_000);
});

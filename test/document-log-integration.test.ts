import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, type AppOptions } from '../src/app/server';
import { createDocumentLogWiring } from '../src/app/document-log.wiring';
import {
  createDocumentDynamicValidationAdapter,
  createDocumentOptionTableAdapter,
  createLookupOptionsService,
} from '../src/app/lookup-options.wiring';
import {
  createDocumentServiceFactory,
  wireDocumentServicesAndRoutes,
} from '../src/app/document.wiring';
import { createHttpServer } from '../src/infrastructure/http';
import { ActivityEngine } from '../src/features/document/adapters/activity-engine';
import { CompiledSchemaRegistry } from '../src/features/document/adapters/compiled-schema-registry';
import { DocumentSchemaRegistryAdapter } from '../src/features/document/adapters/document-schema-registry';
import { DriveActivityHandler } from '../src/features/document/adapters/drive-activity-handler';
import {
  DocumentService,
  type Activity,
  type Document,
  type DocumentType,
} from '../src/features/document/domain';
import type {
  ActivityHandler,
  ActivityOutput,
  DocumentOptionTablePort,
  DocumentSchemaRegistryPort,
} from '../src/features/document/ports';
import {
  DocumentLogConfigurationError,
  type DocumentLogDuplicatePolicy,
  type DocumentLogPort,
  type RawManifestProviderPort,
} from '../src/features/document-log';
import { GoogleDriveClient, type GoogleDriveClientOptions } from '../src/infrastructure/drive/drive-client';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { GoogleSheetsClient, type GoogleSheetsClientOptions } from '../src/infrastructure/sheets';
import { HandlebarsAdapter } from '../src/infrastructure/template-engine/handlebars-adapter';
import { ensureEvaluationOrder } from '../src/infrastructure/validation/json-logic-graph';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type { DocumentSpaceStoragePort } from '../src/features/document-space/ports';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';

interface FixtureSubmittalEntry {
  documentData: Record<string, unknown>;
  actionName: string;
  fileUri: string | null;
  identity: { idGroup: string; idDocument: string; id: string };
}

interface FixtureWriteScenario extends FixtureSubmittalEntry {
  scenario: string;
  description: string;
  fileUri: string;
}

interface FixturePartialHydrationRow {
  scenario: string;
  description: string;
  rowCells: Record<string, string>;
  linkFormula: string;
  expectedIssues: string[];
}

const sampleFixture = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'fixtures/document-log-sample-data.json'), 'utf-8')
) as {
  space: {
    id: string;
    typeId: string;
    name: string;
    abstractStorageId: string;
    expectedLogFileName: string;
  };
  submittalArch: {
    sheetName: string;
    rangeName: string;
    headers: string[];
    seedEntries: FixtureSubmittalEntry[];
    writeScenarios: FixtureWriteScenario[];
    partialHydrationRows: FixturePartialHydrationRow[];
  };
  submittalFfe: {
    sheetName: string;
    rangeName: string;
    headers: string[];
    formulaOwnedColumns: string[];
    seedEntries: FixtureSubmittalEntry[];
    writeScenarios: FixtureWriteScenario[];
    partialHydrationRows: FixturePartialHydrationRow[];
  };
};

interface MockDriveState {
  searchResults: Array<{
    id: string;
    name: string;
    parents?: string[];
    mimeType?: string;
    webViewLink?: string;
  }>;
}

function createMockDriveSdk(state: MockDriveState): NonNullable<GoogleDriveClientOptions['drive']> {
  const list = vi.fn().mockImplementation(async (params: { q?: string }) => {
    const q = params.q ?? '';
    // Folder resolution for MOVE_FILE ("6 Construction" -> "Submittals")
    if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
      if (q.includes("name = '6 Construction'")) {
        return {
          data: {
            files: [
              {
                id: 'folder-6-construction',
                name: '6 Construction',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [sampleFixture.space.abstractStorageId],
              },
            ],
          },
        };
      }
      if (q.includes("name = 'Submittals'")) {
        return {
          data: {
            files: [
              {
                id: 'folder-submittals',
                name: 'Submittals',
                mimeType: 'application/vnd.google-apps.folder',
                parents: ['folder-6-construction'],
              },
            ],
          },
        };
      }
      if (q.includes("name = '3 FFE'")) {
        return {
          data: {
            files: [
              {
                id: 'folder-3-ffe',
                name: '3 FFE',
                mimeType: 'application/vnd.google-apps.folder',
                parents: [sampleFixture.space.abstractStorageId],
              },
            ],
          },
        };
      }
      if (q.includes("name = '05 Submittals'")) {
        return {
          data: {
            files: [
              {
                id: 'folder-ffe-submittals',
                name: '05 Submittals',
                mimeType: 'application/vnd.google-apps.folder',
                parents: ['folder-3-ffe'],
              },
            ],
          },
        };
      }
      return { data: { files: [] } };
    }

    // Spreadsheet discovery for resolveLog
    if (q.includes("mimeType = 'application/vnd.google-apps.spreadsheet'")) {
      return {
        data: {
          files: state.searchResults,
        },
      };
    }

    return { data: { files: [] } };
  });

  const get = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({
    data: {
      id: fileId,
      name: '071200-001-0 Fluid-Applied Waterproofing Membrane.pdf',
      parents: ['inbox-folder'],
      mimeType: 'application/pdf',
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    },
  }));

  const update = vi.fn().mockImplementation(async ({ fileId }: { fileId: string }) => ({
    data: {
      id: fileId,
      name: '071200-001-0 Fluid-Applied Waterproofing Membrane - 260204 MB.pdf',
      parents: ['folder-submittals'],
      mimeType: 'application/pdf',
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    },
  }));

  return {
    files: { list, get, update },
  } as unknown as NonNullable<GoogleDriveClientOptions['drive']>;
}

type SimCellValue = string | number | boolean | null;

interface MockCellData {
  userEnteredValue?: {
    stringValue?: string;
    numberValue?: number;
    boolValue?: boolean;
    formulaValue?: string;
  };
}

interface MockBatchRequest {
  insertDimension?: {
    range?: {
      sheetId?: number;
      dimension?: string;
      startIndex?: number;
      endIndex?: number;
    };
    inheritFromBefore?: boolean;
  };
  deleteDimension?: {
    range?: {
      sheetId?: number;
      dimension?: string;
      startIndex?: number;
      endIndex?: number;
    };
  };
  updateCells?: {
    range?: {
      sheetId?: number;
      startRowIndex?: number;
      endRowIndex?: number;
      startColumnIndex?: number;
      endColumnIndex?: number;
    };
    rows?: Array<{ values?: MockCellData[] }>;
    fields?: string;
  };
}

interface SimulatedNamedRange {
  namedRangeId: string;
  name: string;
  range: {
    sheetId: number;
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  };
}

interface MockSheetsState {
  tableValues: Array<Array<SimCellValue>>;
  batchUpdates: Array<{ spreadsheetId: string; requests: MockBatchRequest[] }>;
  grid?: Array<Array<SimCellValue>>;
  namedRange?: SimulatedNamedRange;
  archStatusesRows?: SimCellValue[][];
  archActionsRows?: SimCellValue[][];
}

function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

function parseA1RangeBounds(
  a1Range: string,
  defaultEndRowIndex: number,
  defaultEndColumnIndex: number
): {
  startRowIndex: number;
  endRowIndex: number;
  startColumnIndex: number;
  endColumnIndex: number;
} {
  const bangIdx = a1Range.lastIndexOf('!');
  const cellRange = bangIdx >= 0 ? a1Range.slice(bangIdx + 1) : a1Range;
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d*)$/i.exec(cellRange.trim());
  if (!match) {
    return {
      startRowIndex: 0,
      endRowIndex: defaultEndRowIndex,
      startColumnIndex: 0,
      endColumnIndex: defaultEndColumnIndex,
    };
  }
  return {
    startRowIndex: Number(match[2]) - 1,
    endRowIndex: match[4] ? Number(match[4]) : defaultEndRowIndex,
    startColumnIndex: columnLettersToIndex(match[1].toUpperCase()),
    endColumnIndex: columnLettersToIndex(match[3].toUpperCase()) + 1,
  };
}

function extractSimCellValue(cell: MockCellData | undefined): SimCellValue {
  const value = cell?.userEnteredValue;
  if (!value) {
    return null;
  }
  if (value.stringValue !== undefined) {
    return value.stringValue;
  }
  if (value.numberValue !== undefined) {
    return value.numberValue;
  }
  if (value.boolValue !== undefined) {
    return value.boolValue;
  }
  if (value.formulaValue !== undefined) {
    return value.formulaValue;
  }
  return null;
}

function formatCellForValuesGet(
  cell: SimCellValue | undefined,
  valueRenderOption?: string
): SimCellValue {
  if (cell === null || cell === undefined) {
    return '';
  }
  if (typeof cell === 'string' && valueRenderOption !== 'FORMULA') {
    if (cell === '=SPILL_EMPTY') {
      return '';
    }
    const hyperlinkMatch = /^=HYPERLINK\("([^"]*)",\s*"([^"]*)"\)$/i.exec(cell);
    if (hyperlinkMatch) {
      return hyperlinkMatch[2];
    }
  }
  return cell;
}

function applyBatchUpdate(
  state: { grid: SimCellValue[][]; namedRange: SimulatedNamedRange },
  requests: MockBatchRequest[]
): void {
  for (const req of requests) {
    if (req.insertDimension?.range) {
      const { dimension, startIndex, endIndex } = req.insertDimension.range;
      if (dimension === 'ROWS' && startIndex !== undefined && endIndex !== undefined) {
        const count = endIndex - startIndex;
        const insertedRows = Array.from({ length: count }, () => [] as SimCellValue[]);
        state.grid.splice(startIndex, 0, ...insertedRows);
        if (startIndex < state.namedRange.range.startRowIndex) {
          state.namedRange.range.startRowIndex += count;
          state.namedRange.range.endRowIndex += count;
        } else if (startIndex <= state.namedRange.range.endRowIndex) {
          state.namedRange.range.endRowIndex += count;
        }
      }
      continue;
    }

    if (req.deleteDimension?.range) {
      const { dimension, startIndex, endIndex } = req.deleteDimension.range;
      if (dimension === 'ROWS' && startIndex !== undefined && endIndex !== undefined) {
        const count = endIndex - startIndex;
        state.grid.splice(startIndex, count);
        const nrStart = state.namedRange.range.startRowIndex;
        const nrEnd = state.namedRange.range.endRowIndex;
        if (endIndex <= nrStart) {
          state.namedRange.range.startRowIndex -= count;
          state.namedRange.range.endRowIndex -= count;
        } else if (startIndex < nrEnd) {
          const overlapStart = Math.max(startIndex, nrStart);
          const overlapEnd = Math.min(endIndex, nrEnd);
          const overlapCount = Math.max(0, overlapEnd - overlapStart);
          if (startIndex < nrStart) {
            state.namedRange.range.startRowIndex = startIndex;
          }
          state.namedRange.range.endRowIndex =
            nrEnd - overlapCount - Math.max(0, nrStart - startIndex);
        }
      }
      continue;
    }

    if (req.updateCells) {
      const startRow = req.updateCells.range?.startRowIndex ?? 0;
      const startCol = req.updateCells.range?.startColumnIndex ?? 0;
      const rows = req.updateCells.rows ?? [];
      for (let rowOffset = 0; rowOffset < rows.length; rowOffset++) {
        const absRow = startRow + rowOffset;
        while (state.grid.length <= absRow) {
          state.grid.push([]);
        }
        const gridRow = state.grid[absRow];
        const rowValues = rows[rowOffset]?.values ?? [];
        for (let colOffset = 0; colOffset < rowValues.length; colOffset++) {
          const absCol = startCol + colOffset;
          while (gridRow.length <= absCol) {
            gridRow.push(null);
          }
          gridRow[absCol] = extractSimCellValue(rowValues[colOffset]);
        }
      }
    }
  }
}

const CONFIG_STATUSES: SimCellValue[][] = [
  ['Status'],
  ['Open'],
  ['Closed'],
  ['Waiting'],
  ['Manager'],
  ['Billed'],
  ['---'],
];

const CONFIG_ACTIONS: SimCellValue[][] = [
  ['Action', 'Name', 'Suffix', 'Order'],
  ['REC', 'Received', '', '1'],
  ['REF', 'Referred', '_REF', '2'],
  ['NR', 'Not Reviewed', '_NR', '3'],
  ['REJ', 'Rejected', '_REJ', '4'],
  ['RR', 'Revise & Resubmit', '_RR', '5'],
  ['NOC', 'No Objections As Corrected', '_NOC', '6'],
  ['NET', 'No Exceptions Taken', '_NET', '7'],
  ['---', '', '', ''],
];

const CONFIG_ARCH_CONTACTS: SimCellValue[][] = [
  ['Contact', 'Name', 'Contact Type'],
  ['INC', 'INC Architecture and Design', 'INC'],
  ['PMG', 'Pavarini McGovern', 'Contractor'],
  ['FXC', 'FX Collaborative', 'Architect'],
  ['IE', 'Interface Engineering', 'MEP'],
  ['VLD', 'Ventresca Lighting Design', 'Lighting'],
  ['TT', 'Thornton Tomasetti', 'Structural'],
  ['ARC', 'Apex Architecture Studio', 'Architect'],
  ['MB', 'Meridian Builders', 'Contractor'],
  ['SME', 'Summit MEP Engineers', 'MEP'],
  ['PST', 'Pillar Structural Consultants', 'Structural'],
  ['LMD', 'Lumen Lighting Design', 'Lighting'],
  ['HPG', 'Harbor Procurement Group', 'Procurement'],
  ['OBR', 'Oceanview Brand Standards', 'Brand'],
  ['---', '', ''],
];

const CONFIG_ARCH_CSI_DIVISIONS: SimCellValue[][] = [
  ['Division Number', 'Division Folder'],
  ['01', '01 General Requirements'],
  ['03', '03 Concrete'],
  ['07', '07 Thermal and Moisture Protection'],
  ['08', '08 Openings'],
  ['09', '09 Finishes'],
  ['90', '90 Commissioning'],
  ['---', ''],
];

function createStaticCsiDivisionsOptionTablePort(): DocumentOptionTablePort {
  return {
    resolveOptionTables: async () => ({
      csiDivisions: {
        status: 'ready',
        tuples: [
          { key: '01', folder: '01 General Requirements' },
          { key: '03', folder: '03 Concrete' },
          { key: '07', folder: '07 Thermal and Moisture Protection' },
          { key: '08', folder: '08 Openings' },
          { key: '09', folder: '09 Finishes' },
        ],
      },
    }),
  };
}

const CONFIG_FFE_CONTACTS: SimCellValue[][] = [
  ['Contact', 'Name', 'Contact Type'],
  ['INC', 'INC Architecture & Design', 'INC'],
  ['BW', 'Benjamin West', 'Procurement'],
  ['VLD', 'Ventresca Lighting Design', 'Lighting'],
  ['IHG', 'IHG Hotels & Resorts', 'Brand'],
  ['ARC', 'Apex Architecture Studio', 'Architect'],
  ['MB', 'Meridian Builders', 'Contractor'],
  ['SME', 'Summit MEP Engineers', 'MEP'],
  ['PST', 'Pillar Structural Consultants', 'Structural'],
  ['LMD', 'Lumen Lighting Design', 'Lighting'],
  ['HPG', 'Harbor Procurement Group', 'Procurement'],
  ['OBR', 'Oceanview Brand Standards', 'Brand'],
  ['---', '', ''],
];

const CONFIG_FFE_VENDORS: SimCellValue[][] = [
  ['Vendor', 'Name', 'Vendor Type'],
  ['BM', 'Berman Falk', 'Casegoods'],
  ['AL', 'Ashley Lighting', 'Lighting'],
  ['Carn', 'Carnegie', 'Fabric'],
  ['Delta', 'Delta', 'Fabric'],
  ['FDT', 'Fil Doux Textiles', 'Fabric'],
  ['LA', 'Light Annex', 'Lighting'],
  ['MH', 'Mohawk', 'Fabric'],
  ['KC', 'Keystone Casegoods', 'Casegoods'],
  ['CL', 'Crestline Lighting', 'Lighting'],
  ['AT', 'Atlas Textiles', 'Fabric'],
  ['VM', 'Vanguard Mills', 'Carpet'],
  ['NF', 'Northstar Furnishings', 'Furniture'],
  ['---', '', ''],
];

const CONFIG_FFE_SPECS: SimCellValue[][] = [
  ['Spec Tag', 'Spec Title'],
  ['AC102', 'HOOK'],
  ['CG104', 'BED - KING'],
  ['CP119', 'CARPET'],
  ['FB127', 'FABRIC - LEATHER'],
  ['LT108', 'SCONCE'],
  ['LT159A', 'SCONCE - CORRIDOR'],
  ['TA139', 'TABLE - WORK'],
  ['---', ''],
];

function createMockSheetsSdk(state: MockSheetsState): NonNullable<GoogleSheetsClientOptions['sheets']> {
  const archStatusesRows = state.archStatusesRows ?? [
    ['Status'],
    ['Open'],
    ['Closed'],
    ['Waiting'],
    ['Manager'],
    ['---'],
  ];
  const archActionsRows = state.archActionsRows ?? [
    ['Action', 'Name', 'Suffix', 'Order'],
    ['REC', 'Received', '', '1'],
    ['REF', 'Referred', '_REF', '2'],
    ['NR', 'Not Reviewed', '_NR', '3'],
    ['REJ', 'Rejected', '_REJ', '4'],
    ['RR', 'Revise & Resubmit', '_RR', '5'],
    ['NOC', 'No Objections As Corrected', '_NOC', '6'],
    ['NET', 'No Exceptions Taken', '_NET', '7'],
    ['---', '', '', ''],
  ];

  const getMetadata = vi.fn().mockImplementation(async ({ spreadsheetId }: { spreadsheetId: string }) => ({
    data: {
      spreadsheetId,
      sheets: [
        { properties: { sheetId: 101, title: sampleFixture.submittalArch.sheetName } },
        { properties: { sheetId: 102, title: sampleFixture.submittalFfe.sheetName } },
        { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
        { properties: { sheetId: 104, title: '_Config Submittal FF&E' } },
      ],
      namedRanges: [
        state.namedRange
          ? {
              ...state.namedRange,
              range: { ...state.namedRange.range },
            }
          : {
              namedRangeId: 'nr-arch',
              name: sampleFixture.submittalArch.rangeName,
              range: {
                sheetId: 101,
                startRowIndex: 2,
                endRowIndex: 25,
                startColumnIndex: 0,
                endColumnIndex: 10,
              },
            },
        {
          namedRangeId: 'nr-arch-statuses',
          name: 'Options_Submittal_Arch_Statuses',
          range: {
            sheetId: 103,
            startRowIndex: 0,
            endRowIndex: archStatusesRows.length,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
        },
        {
          namedRangeId: 'nr-arch-statuses-val',
          name: 'Validation_Submittal_Arch_Statuses',
          range: {
            sheetId: 103,
            startRowIndex: 1,
            endRowIndex: archStatusesRows.length - 1,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
        },
        {
          namedRangeId: 'nr-arch-actions',
          name: 'Options_Submittal_Arch_Actions',
          range: {
            sheetId: 103,
            startRowIndex: 0,
            endRowIndex: archActionsRows.length,
            startColumnIndex: 2,
            endColumnIndex: 6,
          },
        },
        {
          namedRangeId: 'nr-arch-contacts',
          name: 'Options_Submittal_Arch_Contacts',
          range: {
            sheetId: 103,
            startRowIndex: 0,
            endRowIndex: CONFIG_ARCH_CONTACTS.length,
            startColumnIndex: 7,
            endColumnIndex: 10,
          },
        },
        {
          namedRangeId: 'nr-arch-contacts-val',
          name: 'Validation_Submittal_Arch_Contacts',
          range: {
            sheetId: 103,
            startRowIndex: 1,
            endRowIndex: CONFIG_ARCH_CONTACTS.length - 1,
            startColumnIndex: 7,
            endColumnIndex: 8,
          },
        },
        {
          namedRangeId: 'nr-arch-csi-divisions',
          name: 'Options_Submittal_Arch_CSI_Divisions',
          range: {
            sheetId: 103,
            startRowIndex: 0,
            endRowIndex: CONFIG_ARCH_CSI_DIVISIONS.length,
            startColumnIndex: 11,
            endColumnIndex: 13,
          },
        },
        {
          namedRangeId: 'nr-ffe-statuses',
          name: 'Options_Submittal_FFE_Statuses',
          range: {
            sheetId: 104,
            startRowIndex: 0,
            endRowIndex: CONFIG_STATUSES.length,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
        },
        {
          namedRangeId: 'nr-ffe-statuses-val',
          name: 'Validation_Submittal_FFE_Statuses',
          range: {
            sheetId: 104,
            startRowIndex: 1,
            endRowIndex: CONFIG_STATUSES.length - 1,
            startColumnIndex: 0,
            endColumnIndex: 1,
          },
        },
        {
          namedRangeId: 'nr-ffe-actions',
          name: 'Options_Submittal_FFE_Actions',
          range: {
            sheetId: 104,
            startRowIndex: 0,
            endRowIndex: CONFIG_ACTIONS.length,
            startColumnIndex: 2,
            endColumnIndex: 6,
          },
        },
        {
          namedRangeId: 'nr-ffe-contacts',
          name: 'Options_Submittal_FFE_Contacts',
          range: {
            sheetId: 104,
            startRowIndex: 0,
            endRowIndex: CONFIG_FFE_CONTACTS.length,
            startColumnIndex: 7,
            endColumnIndex: 10,
          },
        },
        {
          namedRangeId: 'nr-ffe-contacts-val',
          name: 'Validation_Submittal_FFE_Contacts',
          range: {
            sheetId: 104,
            startRowIndex: 1,
            endRowIndex: CONFIG_FFE_CONTACTS.length - 1,
            startColumnIndex: 7,
            endColumnIndex: 8,
          },
        },
        {
          namedRangeId: 'nr-ffe-vendors',
          name: 'Options_Submittal_FFE_Vendors',
          range: {
            sheetId: 104,
            startRowIndex: 0,
            endRowIndex: CONFIG_FFE_VENDORS.length,
            startColumnIndex: 11,
            endColumnIndex: 14,
          },
        },
        {
          namedRangeId: 'nr-ffe-vendors-val',
          name: 'Validation_Submittal_FFE_Vendors',
          range: {
            sheetId: 104,
            startRowIndex: 1,
            endRowIndex: CONFIG_FFE_VENDORS.length - 1,
            startColumnIndex: 11,
            endColumnIndex: 12,
          },
        },
        {
          namedRangeId: 'nr-ffe-specs',
          name: 'Options_Submittal_FFE_Specs',
          range: {
            sheetId: 104,
            startRowIndex: 0,
            endRowIndex: CONFIG_FFE_SPECS.length,
            startColumnIndex: 15,
            endColumnIndex: 17,
          },
        },
        {
          namedRangeId: 'nr-ffe-specs-val',
          name: 'Validation_Submittal_FFE_Specs',
          range: {
            sheetId: 104,
            startRowIndex: 1,
            endRowIndex: CONFIG_FFE_SPECS.length - 1,
            startColumnIndex: 15,
            endColumnIndex: 16,
          },
        },
        ...(!state.namedRange
          ? [
              {
                namedRangeId: 'nr-ffe',
                name: sampleFixture.submittalFfe.rangeName,
                range: {
                  sheetId: 102,
                  startRowIndex: 2,
                  endRowIndex: 21,
                  startColumnIndex: 0,
                  endColumnIndex: 11,
                },
              },
            ]
          : []),
      ],
    },
  }));

  const sliceRowsForRange = (range: string, valueRenderOption?: string): SimCellValue[][] => {
    if (range.includes('_Config Submittal Arch')) {
      const bounds = parseA1RangeBounds(range, 30, 15);
      if (bounds.startColumnIndex === 0) {
        return archStatusesRows;
      }
      if (bounds.startColumnIndex === 2) {
        return archActionsRows;
      }
      if (bounds.startColumnIndex === 7) {
        return CONFIG_ARCH_CONTACTS;
      }
      if (bounds.startColumnIndex === 11) {
        return CONFIG_ARCH_CSI_DIVISIONS;
      }
      return [];
    }
    if (range.includes('_Config Submittal FF&E')) {
      const bounds = parseA1RangeBounds(range, 30, 17);
      if (bounds.startColumnIndex === 0) {
        return CONFIG_STATUSES;
      }
      if (bounds.startColumnIndex === 2) {
        return CONFIG_ACTIONS;
      }
      if (bounds.startColumnIndex === 7) {
        return CONFIG_FFE_CONTACTS;
      }
      if (bounds.startColumnIndex === 11) {
        return CONFIG_FFE_VENDORS;
      }
      if (bounds.startColumnIndex === 15) {
        return CONFIG_FFE_SPECS;
      }
      return [];
    }
    if (state.grid) {
      const bounds = parseA1RangeBounds(
        range,
        state.grid.length,
        state.namedRange?.range.endColumnIndex ?? 10
      );
      return state.grid
        .slice(bounds.startRowIndex, bounds.endRowIndex)
        .map((row) => {
          const formatted: SimCellValue[] = [];
          const colLimit = Math.min(row.length, bounds.endColumnIndex);
          for (let c = bounds.startColumnIndex; c < colLimit; c++) {
            formatted.push(formatCellForValuesGet(row[c], valueRenderOption));
          }
          while (formatted.length > 0 && formatted[formatted.length - 1] === '') {
            formatted.pop();
          }
          return formatted;
        });
    }

    const nrStartRow = state.namedRange?.range.startRowIndex ?? 2;
    const nrStartCol = state.namedRange?.range.startColumnIndex ?? 0;
    const bounds = parseA1RangeBounds(
      range,
      nrStartRow + state.tableValues.length,
      nrStartCol + 15
    );
    const relStartRow = Math.max(0, bounds.startRowIndex - nrStartRow);
    const relEndRow = Math.max(relStartRow, bounds.endRowIndex - nrStartRow);
    const relStartCol = Math.max(0, bounds.startColumnIndex - nrStartCol);
    const relEndCol = Math.max(relStartCol, bounds.endColumnIndex - nrStartCol);
    return state.tableValues
      .slice(relStartRow, relEndRow)
      .map((row) =>
        row
          .slice(relStartCol, relEndCol)
          .map((cell) => formatCellForValuesGet(cell, valueRenderOption))
      );
  };

  const valuesGet = vi.fn().mockImplementation(
    async (params?: { range?: string; valueRenderOption?: string }) => ({
      data: {
        values: sliceRowsForRange(params?.range ?? '', params?.valueRenderOption),
      },
    })
  );

  const valuesBatchGet = vi.fn().mockImplementation(
    async (params?: { ranges?: string[]; valueRenderOption?: string }) => ({
      data: {
        spreadsheetId: 'mock-spreadsheet-id',
        valueRanges: (params?.ranges ?? []).map((range) => ({
          range,
          values: sliceRowsForRange(range, params?.valueRenderOption),
        })),
      },
    })
  );

  const batchUpdate = vi.fn().mockImplementation(
    async ({
      spreadsheetId,
      requestBody,
    }: {
      spreadsheetId: string;
      requestBody: { requests?: MockBatchRequest[] };
    }) => {
      const requests = requestBody.requests ?? [];
      state.batchUpdates.push({
        spreadsheetId,
        requests,
      });
      if (state.grid && state.namedRange) {
        applyBatchUpdate({ grid: state.grid, namedRange: state.namedRange }, requests);
      }
      return { data: {} };
    }
  );

  return {
    spreadsheets: {
      get: getMetadata,
      batchUpdate,
      values: {
        get: valuesGet,
        batchGet: valuesBatchGet,
        update: vi.fn().mockResolvedValue({ data: {} }),
      },
    },
  } as unknown as NonNullable<GoogleSheetsClientOptions['sheets']>;
}

describe('DocumentLog Tracer Bullet Integration (Issue #339)', () => {
  const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
  let manifestProvider: AppManifestProvider;
  let handlebars: HandlebarsAdapter;

  beforeEach(() => {
    manifestProvider = new AppManifestProvider({ manifestPath });
    handlebars = new HandlebarsAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function buildWiredDocumentService(params: {
    driveState: MockDriveState;
    sheetsState: MockSheetsState;
    primaryTargetId?: string;
    sourceFiles?: Array<{ id: string; name?: string }>;
    selectedLogId?: string;
    manifestProviderOverride?: RawManifestProviderPort;
    optionTablePortOverride?: DocumentOptionTablePort;
  }) {
    const driveSdk = createMockDriveSdk(params.driveState);
    const sheetsSdk = createMockSheetsSdk(params.sheetsState);
    const driveClient = new GoogleDriveClient({
      drive: driveSdk,
      configProvider: manifestProvider,
    });
    const sheetsClient = new GoogleSheetsClient({
      sheets: sheetsSdk,
      configProvider: manifestProvider,
    });

    const schemaManifestProvider: RawManifestProviderPort =
      params.manifestProviderOverride ?? manifestProvider;

    const docSchemaRegistry = new DocumentSchemaRegistryAdapter(
      schemaManifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const compiledRegistry = new CompiledSchemaRegistry(docSchemaRegistry);
    await compiledRegistry.initialize();

    const logWiring = createDocumentLogWiring({
      manifestProvider: schemaManifestProvider,
      driveClient,
      sheetsClient,
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const driveActivityHandler = new DriveActivityHandler(
      {
        getFile: (id) => driveClient.getFile(id),
        findOrCreateFolder: (p, n) => driveClient.findOrCreateFolder(p, n),
        resolveFolderPath: (r, s) => driveClient.resolveFolderPath(r, s),
        move: (f, t) => driveClient.move(f, t),
        rename: (f, n) => driveClient.rename(f, n),
        duplicate: (f, o) => driveClient.duplicate(f, o),
        searchFiles: (q) => driveClient.searchFiles(q),
        downloadAsBuffer: (f) => driveClient.downloadAsBuffer(f),
        saveBuffer: (c, o) => driveClient.saveBuffer(c, o),
        uploadStream: (s, o) => driveClient.uploadStream(s, o),
      },
      {
        configProvider: manifestProvider,
        ...(params.primaryTargetId !== undefined ? { primaryTargetId: params.primaryTargetId } : {}),
        ...(params.sourceFiles !== undefined ? { sourceFiles: params.sourceFiles } : {}),
      }
    );

    const logHandler = logWiring.createActivityHandler({
      ...(params.selectedLogId !== undefined ? { selectedLogId: params.selectedLogId } : {}),
    });

    const lookupOptions = createLookupOptionsService({
      manifestProvider: schemaManifestProvider,
      documentSchemaRegistry: docSchemaRegistry,
      driveClient,
      configProvider: manifestProvider,
      documentLogService: logWiring.documentLogService,
      ensureDocumentLogInitialized: () => logWiring.logSchemaRegistry.initialize(),
    });
    const activityEngine = new ActivityEngine([driveActivityHandler, logHandler]);
    const documentService = new DocumentService(
      activityEngine,
      docSchemaRegistry,
      handlebars,
      compiledRegistry,
      createDocumentDynamicValidationAdapter(lookupOptions),
      undefined,
      params.selectedLogId,
      params.optionTablePortOverride ?? createDocumentOptionTableAdapter(lookupOptions)
    );
    await documentService.initialize();

    return {
      documentService,
      driveSdk,
      sheetsSdk,
      driveClient,
      sheetsClient,
    };
  }

  it('executes FileSubmittalArch MOVE_FILE -> WRITE_LOG into an empty/cleared log with =HYPERLINK Calc Link and preserved leading zeros', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'copy-tmpl',
          name: 'Copy of Harborview Hotel Document Log',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        {
          id: 'org-tmpl',
          name: 'INC Document Log Template',
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: ['admin-folder-1'],
        },
      ],
    };
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [], // Row 4 Formula Row
        ['<--->'], // Row 5 Top Anchor
        [], // Row 6 Cleared Placeholder Row
        ['<--->'], // Row 7 Bottom Anchor
      ],
      batchUpdates: [],
    };

    const { documentService } = await buildWiredDocumentService({
      driveState,
      sheetsState,
      primaryTargetId: 'moved-submittal-file-001',
    });

    const seedEntry = sampleFixture.submittalArch.seedEntries[2]; // 071200-001-0 REC
    const doc: Document = {
      type: 'submittal-arch',
      space: {
        id: sampleFixture.space.id,
        typeId: sampleFixture.space.typeId,
        name: sampleFixture.space.name,
        abstractStorageId: sampleFixture.space.abstractStorageId,
      },
      data: seedEntry.documentData,
    };

    const result = await documentService.processDocument(doc, 'onSubmit');
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
    expect(result.contextVariables).toEqual({
      documentLogWrite: {
        spreadsheetId: 'harborview-log-1',
        sheetName: 'Submittal Arch',
        rowNumber: 6,
        action: 'inserted',
      },
    });

    expect(sheetsState.batchUpdates).toHaveLength(1);
    const updateReq = sheetsState.batchUpdates[0].requests.find((r) => r.updateCells)?.updateCells;
    expect(updateReq?.range?.startRowIndex).toBe(5); // 0-based Row 6
    const cells = updateReq?.rows?.[0]?.values ?? [];
    expect(cells).toEqual([
      { userEnteredValue: { stringValue: 'Open' } },
      { userEnteredValue: { stringValue: '071200' } },
      { userEnteredValue: { stringValue: '001' } },
      { userEnteredValue: { stringValue: '0' } },
      { userEnteredValue: { stringValue: 'Fluid-Applied Waterproofing Membrane' } },
      { userEnteredValue: { stringValue: '260204' } },
      { userEnteredValue: { stringValue: 'MB' } },
      { userEnteredValue: { stringValue: 'Received' } },
      { userEnteredValue: { stringValue: 'Terrace deck assembly' } },
      {
        userEnteredValue: {
          formulaValue:
            '=HYPERLINK("https://drive.google.com/file/d/moved-submittal-file-001/view", "Link")',
        },
      },
    ]);
  });

  it('appends to a non-empty log and leaves Calc Link blank (null) when MOVE_FILE yields zero files', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        ['Closed', '033000', '001', '0', 'Concrete Mix', '260115', 'MB', 'Received', '4000 psi', 'Link'],
        ['<--->'],
      ],
      batchUpdates: [],
    };

    const { documentService } = await buildWiredDocumentService({
      driveState,
      sheetsState,
      sourceFiles: [],
    });

    const result = await documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: {
          status: 'Waiting',
          section: '071200',
          number: '002',
          revision: '0',
          title: 'Below-Grade Sheet Waterproofing',
          date: '260219',
          contact: 'PST',
          action: 'REF',
          notes: '',
        },
      },
      'onSubmit'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 8,
      action: 'inserted',
    });

    const batchReqs = sheetsState.batchUpdates[0].requests;
    expect(batchReqs).toHaveLength(3);
    expect(batchReqs[0].insertDimension).toEqual({
      range: {
        sheetId: 101,
        dimension: 'ROWS',
        startIndex: 6,
        endIndex: 8,
      },
      inheritFromBefore: true,
    });
    expect(batchReqs[1].updateCells).toEqual({
      range: {
        sheetId: 101,
        startRowIndex: 6,
        endRowIndex: 7,
        startColumnIndex: 0,
        endColumnIndex: 1,
      },
      rows: [{ values: [{ userEnteredValue: { stringValue: '---' } }] }],
      fields: 'userEnteredValue',
    });
    expect(batchReqs[2].updateCells?.range?.startRowIndex).toBe(7);
    const cells = batchReqs[2].updateCells?.rows?.[0]?.values ?? [];
    expect(cells[8]).toEqual({}); // Notes: empty optional -> null -> {}
    expect(cells[9]).toEqual({}); // Calc Link: zero-file -> null -> {}
  });

  it('supports fileSourceStepId multi-step chaining and fails fast when referencing an unexecuted step', async () => {
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    };
    const driveSdk = createMockDriveSdk({
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    });
    const sheetsSdk = createMockSheetsSdk(sheetsState);
    const logWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient: new GoogleDriveClient({ drive: driveSdk }),
      sheetsClient: new GoogleSheetsClient({ sheets: sheetsSdk }),
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const makeMultiStepType = (fileSourceStepId: string): DocumentType => {
      const archRaw = fs.readFileSync(
        path.resolve(__dirname, '../assets/document-types/submittal-arch.json'),
        'utf-8'
      );
      const archDef = JSON.parse(archRaw) as DocumentType;
      return {
        ...archDef,
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'FileSubmittalArch',
              activitySequence: [
                { id: 'createSubmittal', type: 'CREATE_SUBMITTAL', payload: {} },
                { id: 'archiveCopy', type: 'ARCHIVE_COPY', payload: {} },
                { id: 'writeLog', type: 'WRITE_LOG', payload: { fileSourceStepId } },
              ],
            },
          ],
        },
      };
    };

    const runWithStepId = async (stepId: string) => {
      const customRegistry: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([makeMultiStepType(stepId)]),
      };
      const compiled = new CompiledSchemaRegistry(customRegistry);
      await compiled.initialize();

      const createHandler: ActivityHandler = {
        canHandle: (a) => a.type === 'CREATE_SUBMITTAL',
        handle: () => ({
          success: true,
          files: [
            {
              id: 'primary-submittal-id',
              name: 'Primary.pdf',
              uri: 'https://drive.google.com/file/d/primary-submittal-id/view',
            },
          ],
        }),
      };
      const archiveHandler: ActivityHandler = {
        canHandle: (a) => a.type === 'ARCHIVE_COPY',
        handle: () => ({
          success: true,
          files: [
            {
              id: 'archive-copy-id',
              name: 'Archive.pdf',
              uri: 'https://drive.google.com/file/d/archive-copy-id/view',
            },
          ],
        }),
      };

      const engine = new ActivityEngine([
        createHandler,
        archiveHandler,
        logWiring.createActivityHandler(),
      ]);
      const service = new DocumentService(
        engine,
        customRegistry,
        handlebars,
        compiled,
        undefined,
        undefined,
        undefined,
        createStaticCsiDivisionsOptionTablePort()
      );
      await service.initialize();

      return service.processDocument(
        {
          type: 'submittal-arch',
          space: {
            id: sampleFixture.space.id,
            typeId: sampleFixture.space.typeId,
            name: sampleFixture.space.name,
            abstractStorageId: sampleFixture.space.abstractStorageId,
          },
          data: sampleFixture.submittalArch.seedEntries[0].documentData,
        },
        'onSubmit'
      );
    };

    const okResult = await runWithStepId('createSubmittal');
    expect(okResult.success).toBe(true);
    const cells = sheetsState.batchUpdates[0].requests[0].updateCells?.rows?.[0]?.values ?? [];
    expect(cells[9]).toEqual({
      userEnteredValue: {
        formulaValue:
          '=HYPERLINK("https://drive.google.com/file/d/primary-submittal-id/view", "Link")',
      },
    });

    // Unexecuted / missing step fails fast before hitting Drive/Sheets
    const callsBeforeFail = sheetsState.batchUpdates.length;
    const failResult = await runWithStepId('neverExecutedStep');
    expect(failResult.success).toBe(false);
    if (!failResult.success) {
      expect(failResult.errors[0]).toContain('neverExecutedStep');
    }
    expect(sheetsState.batchUpdates).toHaveLength(callsBeforeFail);
  });

  it('writes user text starting with =, +, -, @ strictly as literal stringValue (never formulaValue)', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    };

    const { documentService } = await buildWiredDocumentService({
      driveState,
      sheetsState,
      primaryTargetId: 'safe-file-1',
    });

    const result = await documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '-100',
          title: '=1+1',
          date: '260204',
          contact: '+CMD',
          action: 'REC',
          notes: '@SUM(A1)',
        },
      },
      'onSubmit'
    );

    expect(result.success).toBe(true);
    const cells =
      sheetsState.batchUpdates[0].requests.find((r) => r.updateCells?.range?.sheetId === 101)
        ?.updateCells?.rows?.[0]?.values ?? [];
    expect(cells[3]).toEqual({ userEnteredValue: { stringValue: '-100' } });
    expect(cells[4]).toEqual({ userEnteredValue: { stringValue: '=1+1' } });
    expect(cells[6]).toEqual({ userEnteredValue: { stringValue: '+CMD' } });
    expect(cells[8]).toEqual({ userEnteredValue: { stringValue: '@SUM(A1)' } });
  });

  it('supports selectedLogId override without calling Drive discovery', async () => {
    const driveSdk = createMockDriveSdk({ searchResults: [] });
    const sheetsState: MockSheetsState = {
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    };
    const sheetsSdk = createMockSheetsSdk(sheetsState);
    const driveClient = new GoogleDriveClient({ drive: driveSdk });
    const sheetsClient = new GoogleSheetsClient({ sheets: sheetsSdk });

    const docSchemaRegistry = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const compiledRegistry = new CompiledSchemaRegistry(docSchemaRegistry);
    await compiledRegistry.initialize();

    const logWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient,
      sheetsClient,
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const factory = createDocumentServiceFactory({
      documentSchemaRegistry: docSchemaRegistry,
      templateEvaluator: handlebars,
      compiledSchemaRegistry: compiledRegistry,
      configProvider: manifestProvider,
      driveClient,
      optionTablePort: createStaticCsiDivisionsOptionTablePort(),
      createAdditionalActivityHandlers: (context) => [
        logWiring.createPerRequestActivityHandler(context),
      ],
    });

    const service = await factory({
      selectedLogId: 'explicit-selected-log-777',
      sourceFiles: [],
    });

    const result = await service.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
      'onSubmit'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'explicit-selected-log-777',
      sheetName: 'Submittal Arch',
      rowNumber: 6,
      action: 'inserted',
    });
    // Zero Drive searchSpreadsheets calls when selectedLogId is provided
    expect(driveSdk.files.list).not.toHaveBeenCalledWith(
      expect.objectContaining({
        q: expect.stringContaining('application/vnd.google-apps.spreadsheet'),
      })
    );
  });

  it('fails fast on missing (0 matches) and ambiguous (2+ matches) without writing to Sheets', async () => {
    const emptyDriveState: MockDriveState = {
      searchResults: [
        { id: 'tmpl-ignored', name: 'INC Document Log Template' },
        { id: 'copy-ignored', name: 'Copy of Project Document Log' },
      ],
    };
    const emptySheetsState: MockSheetsState = { tableValues: [], batchUpdates: [] };
    const missingCtx = await buildWiredDocumentService({
      driveState: emptyDriveState,
      sheetsState: emptySheetsState,
      sourceFiles: [],
      optionTablePortOverride: createStaticCsiDivisionsOptionTablePort(),
    });

    const missingResult = await missingCtx.documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
      'onSubmit'
    );

    expect(missingResult.success).toBe(false);
    if (!missingResult.success) {
      expect(missingResult.errors[0]).toContain(sampleFixture.space.name);
      expect(missingResult.errors[0]).toContain('1 Admin');
    }
    expect(missingCtx.sheetsSdk.spreadsheets.batchUpdate).not.toHaveBeenCalled();

    const ambiguousDriveState: MockDriveState = {
      searchResults: [
        { id: 'log-1', name: 'Harborview Hotel Document Log' },
        { id: 'log-2', name: 'Harborview Hotel Document Log v2' },
      ],
    };
    const ambiguousCtx = await buildWiredDocumentService({
      driveState: ambiguousDriveState,
      sheetsState: { tableValues: [], batchUpdates: [] },
      sourceFiles: [],
    });

    const ambiguousResult = await ambiguousCtx.documentService.processDocument(
      {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
      'onSubmit'
    );

    expect(ambiguousResult.success).toBe(false);
    if (!ambiguousResult.success) {
      expect(ambiguousResult.errors[0]).toContain('Harborview Hotel Document Log');
      expect(ambiguousResult.errors[0]).toContain('Harborview Hotel Document Log v2');
    }
    expect(ambiguousCtx.sheetsSdk.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });

  it('wires AppOptions sheetsClient and documentLogService overrides in createApp() across /documents and /workspace/action', async () => {
    const writeLog = vi.fn().mockResolvedValue({
      spreadsheetId: 'override-svc-sheet',
      sheetName: 'Submittal Arch',
      rowNumber: 12,
      action: 'inserted',
    });
    const customDocLogService: DocumentLogPort = {
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidate: {
          id: 'found-sheet-via-override',
          name: 'Active Projects Document Log',
        },
        candidates: [
          {
            id: 'found-sheet-via-override',
            name: 'Active Projects Document Log',
          },
        ],
      }),
      copyLog: vi.fn(),
      queryUiContext: vi.fn().mockResolvedValue(undefined),
      readLog: vi.fn(),
      readOptionTables: vi.fn().mockResolvedValue({
        status: 'ready',
        spreadsheetId: 'override-svc-sheet',
        tables: {
          statuses: {
            status: 'ready',
            tuples: [
              { key: 'Open' },
              { key: 'Closed' },
              { key: 'Waiting' },
              { key: 'Manager' },
              { key: 'Billed' },
            ],
          },
          actions: {
            status: 'ready',
            tuples: [
              { key: 'REC', name: 'Received', suffix: '', order: '1' },
              { key: 'NET', name: 'No Exceptions Taken', suffix: '_NET', order: '7' },
            ],
          },
          contacts: {
            status: 'ready',
            tuples: [
              { key: 'INC', name: 'INC Architecture and Design' },
              { key: 'MB', name: 'Meridian Builders' },
            ],
          },
          csiDivisions: {
            status: 'ready',
            tuples: [
              { key: '01', folder: '01 General Requirements' },
              { key: '03', folder: '03 Concrete' },
              { key: '07', folder: '07 Thermal and Moisture Protection' },
              { key: '08', folder: '08 Openings' },
              { key: '09', folder: '09 Finishes' },
            ],
          },
        },
      }),
      writeLog,
    };

    const headlessDocRegistry = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const headlessCompiled = new CompiledSchemaRegistry(headlessDocRegistry);
    await headlessCompiled.initialize();

    const customLogWiring = createDocumentLogWiring({
      manifestProvider,
      documentLogService: customDocLogService,
    });
    const headlessServer = createHttpServer();
    const headlessService = wireDocumentServicesAndRoutes({
      server: headlessServer,
      driveClient: new GoogleDriveClient({ drive: createMockDriveSdk({ searchResults: [] }) }),
      configProvider: manifestProvider,
      manifestProvider,
      documentSchemaRegistry: headlessDocRegistry,
      templateEvaluator: handlebars,
      compiledSchemaRegistry: headlessCompiled,
      primaryTargetId: 'headless-file-1',
      documentLogService: customDocLogService,
      additionalActivityHandlers: [customLogWiring.createActivityHandler()],
    });
    if ('initialize' in headlessService && typeof headlessService.initialize === 'function') {
      await headlessService.initialize();
    }

    const res = await headlessServer.inject({
      method: 'POST',
      url: '/documents?eventName=onSubmit',
      payload: {
        type: 'submittal-arch',
        space: {
          id: sampleFixture.space.id,
          typeId: sampleFixture.space.typeId,
          name: sampleFixture.space.name,
          abstractStorageId: sampleFixture.space.abstractStorageId,
        },
        data: sampleFixture.submittalArch.seedEntries[0].documentData,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.contextVariables.documentLogWrite).toEqual({
      spreadsheetId: 'override-svc-sheet',
      sheetName: 'Submittal Arch',
      rowNumber: 12,
      action: 'inserted',
    });
    expect(writeLog).toHaveBeenCalledTimes(1);

    const authVerifier: WorkspaceAuthVerifierPort = {
      verifyToken: vi.fn().mockResolvedValue({
        isValid: true,
        payload: { email: 'user@inc.nyc', sub: 'user-1' },
      }),
    };
    const storageAdapter: DocumentSpaceStoragePort = {
      fetchSpaces: vi.fn().mockResolvedValue([
        {
          id: 'proj-1',
          typeId: 'projects',
          name: 'Active Projects',
          abstractStorageId: 'shared-drive-1',
        },
      ]),
      resolveStorageLocation: vi.fn().mockResolvedValue({
        provider: 'google_drive',
        abstractStorageId: 'shared-drive-1',
      }),
    };

    const driveSpy = vi
      .spyOn(GoogleDriveClient.prototype, 'resolveFolderPath')
      .mockResolvedValue({ id: 'const-id', name: '6 Construction' });
    vi.spyOn(GoogleDriveClient.prototype, 'findOrCreateFolder').mockResolvedValue({
      id: 'submittals-id',
      name: 'Submittals',
    });
    vi.spyOn(GoogleDriveClient.prototype, 'getFile').mockResolvedValue({
      id: 'moved-doc-1',
      name: 'Waterproofing.pdf',
      parents: ['inbox-id'],
    });
    vi.spyOn(GoogleDriveClient.prototype, 'move').mockResolvedValue({
      id: 'moved-doc-1',
      name: 'Moved.pdf',
      webViewLink: 'https://drive.google.com/file/d/moved-doc-1/view',
    });
    vi.spyOn(GoogleDriveClient.prototype, 'searchFiles').mockResolvedValue([
      {
        id: 'found-sheet-via-override',
        name: 'Active Projects Document Log',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      },
    ]);

    const appWithDocLogOverride = createApp({
      manifestPath,
      skipSpaceValidation: true,
      documentLogService: customDocLogService,
      authVerifier,
      storageAdapter,
    });
    await appWithDocLogOverride.initialize();
    expect(appWithDocLogOverride.documentLogService).toBe(customDocLogService);

    const overrideWsRes = await appWithDocLogOverride.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.override-test-cred' },
        drive: { selectedItems: [{ id: 'moved-doc-1', title: 'Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['moved-doc-1'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });
    expect(overrideWsRes.statusCode).toBe(200);
    expect(
      JSON.parse(overrideWsRes.payload).action?.notification?.text,
      overrideWsRes.payload
    ).toBe('Document processed successfully');
    expect(writeLog).toHaveBeenCalledTimes(2);

    // Also verify AppOptions.sheetsClient works via /workspace/action even with userOAuthToken
    const mockSheetsSdk = createMockSheetsSdk({
      tableValues: [
        sampleFixture.submittalArch.headers,
        [],
        ['<--->'],
        [],
        ['<--->'],
      ],
      batchUpdates: [],
    });
    const overrideSheetsClient = new GoogleSheetsClient({ sheets: mockSheetsSdk });

    const sheetsOverrideApp = createApp({
      manifestPath,
      skipSpaceValidation: true,
      sheetsClient: overrideSheetsClient,
      authVerifier,
      storageAdapter,
    } satisfies AppOptions);
    await sheetsOverrideApp.initialize();

    const wsRes = await sheetsOverrideApp.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.override-test-cred' },
        drive: { selectedItems: [{ id: 'moved-doc-1', title: 'Waterproofing.pdf' }] },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['moved-doc-1'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['PMG'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });

    expect(wsRes.statusCode).toBe(200);
    const wsBody = JSON.parse(wsRes.payload);
    expect(wsBody.action?.notification?.text).toBe('Document processed successfully');
    expect(mockSheetsSdk.spreadsheets.batchUpdate).toHaveBeenCalledTimes(1);
    expect(driveSpy).toHaveBeenCalled();
  });

  it('fails fast during createApp().initialize() when a manifest has invalid documentLog configuration', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doclog-failfast-'));
    try {
      const archRaw = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../assets/document-types/submittal-arch.json'), 'utf-8')
      ) as Record<string, unknown>;
      fs.writeFileSync(path.join(tmpDir, 'submittal-arch.json'), JSON.stringify(archRaw), 'utf-8');
      const badManifestPath = path.join(tmpDir, 'manifest.json');
      fs.writeFileSync(
        badManifestPath,
        JSON.stringify({
          documentTypes: ['./submittal-arch.json'],
          // Missing configuration.documentLog while submittal-arch declares documentLogSchema
        }),
        'utf-8'
      );

      const badApp = createApp({
        manifestPath: badManifestPath,
        skipSpaceValidation: true,
      });

      await expect(badApp.initialize()).rejects.toThrow(/configuration\.documentLog/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function buildSeededSubmittalArchState(): MockSheetsState {
    const grid: SimCellValue[][] = [
      [], // Row 1
      [], // Row 2
      [...sampleFixture.submittalArch.headers], // Row 3 Headers
      [], // Row 4 Formula Row
      ['<--->'], // Row 5 Top Anchor
    ];

    let previousGroupId: string | undefined;
    for (const entry of sampleFixture.submittalArch.seedEntries) {
      if (previousGroupId !== undefined && previousGroupId !== entry.identity.idGroup) {
        grid.push(['---']);
      }
      previousGroupId = entry.identity.idGroup;
      const d = entry.documentData;
      grid.push([
        String(d.status ?? ''),
        String(d.section ?? ''),
        String(d.number ?? ''),
        String(d.revision ?? ''),
        String(d.title ?? ''),
        String(d.date ?? ''),
        String(d.contact ?? ''),
        entry.actionName,
        typeof d.notes === 'string' && d.notes.length > 0 ? d.notes : null,
        entry.fileUri ? `=HYPERLINK("${entry.fileUri}", "Link")` : null,
      ]);
    }
    grid.push(['<--->']); // Bottom Anchor

    return {
      tableValues: [],
      batchUpdates: [],
      grid,
      namedRange: {
        namedRangeId: 'nr-arch',
        name: sampleFixture.submittalArch.rangeName,
        range: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: grid.length,
          startColumnIndex: 0,
          endColumnIndex: 10,
        },
      },
    };
  }

  function createDuplicatePolicyManifestProvider(
    baseProvider: AppManifestProvider,
    duplicatePolicy: DocumentLogDuplicatePolicy,
    targetFileSubstring = 'submittal-arch'
  ): RawManifestProviderPort {
    return {
      getRawManifest: () => baseProvider.getRawManifest(),
      readParsedSchema: async (relPath: string) => {
        const parsed = await baseProvider.readParsedSchema(relPath);
        if (relPath.includes(targetFileSubstring)) {
          const cloned = structuredClone(parsed) as Record<string, unknown>;
          const docLogSchema = cloned.documentLogSchema as {
            grouping: { duplicatePolicy: DocumentLogDuplicatePolicy };
          };
          docLogSchema.grouping.duplicatePolicy = duplicatePolicy;
          return cloned;
        }
        return parsed;
      },
    };
  }

  it('executes all 5 submittalArch.writeScenarios sequentially with grouped/sorted placement, Column-0 "---" dividers, and leading-zero preservation', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const sheetsState = buildSeededSubmittalArchState();
    const space = {
      id: sampleFixture.space.id,
      typeId: sampleFixture.space.typeId,
      name: sampleFixture.space.name,
      abstractStorageId: sampleFixture.space.abstractStorageId,
    };

    const scenarioResults: Array<{
      scenario: string;
      rowNumber: number;
      action: string;
      requests: MockBatchRequest[];
    }> = [];

    let lastSheetsClient: GoogleSheetsClient | undefined;

    for (const scenario of sampleFixture.submittalArch.writeScenarios) {
      const fileIdMatch = /\/d\/([^/]+)\//.exec(scenario.fileUri);
      const fileId = fileIdMatch?.[1];
      if (!fileId) {
        throw new Error(`Missing Drive fileId in fixture fileUri: ${scenario.fileUri}`);
      }

      const { documentService, sheetsClient } = await buildWiredDocumentService({
        driveState,
        sheetsState,
        primaryTargetId: fileId,
      });
      lastSheetsClient = sheetsClient;

      const batchBefore = sheetsState.batchUpdates.length;
      const result = await documentService.processDocument(
        {
          type: 'submittal-arch',
          space,
          data: scenario.documentData,
        },
        'onSubmit'
      );

      expect(result.success, `Scenario ${scenario.scenario} failed`).toBe(true);
      if (!result.success) return;

      expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
      const writeInfo = result.contextVariables?.documentLogWrite as {
        rowNumber: number;
        action: string;
      };
      expect(sheetsState.batchUpdates.length).toBe(batchBefore + 1);
      const requests = sheetsState.batchUpdates[sheetsState.batchUpdates.length - 1].requests;

      // Verify MOVE_FILE -> WRITE_LOG wrote exact =HYPERLINK formula in Calc Link (column 9)
      const dataUpdate = requests.find(
        (r) => r.updateCells && (r.updateCells.range?.endColumnIndex ?? 0) === 10
      );
      expect(dataUpdate?.updateCells?.rows?.[0]?.values?.[9]).toEqual({
        userEnteredValue: {
          formulaValue: `=HYPERLINK("${scenario.fileUri}", "Link")`,
        },
      });

      scenarioResults.push({
        scenario: scenario.scenario,
        rowNumber: writeInfo.rowNumber,
        action: writeInfo.action,
        requests,
      });
    }

    // 1) insertTopNewGroup: 013300-001 at Row 6, inheritFromBefore: false, "---" in Col 0 at Row 7, zero dividers adjacent to top <--->
    const topRes = scenarioResults[0];
    expect(topRes.scenario).toBe('insertTopNewGroup');
    expect(topRes.rowNumber).toBe(6);
    expect(topRes.action).toBe('inserted');
    expect(topRes.requests[0].insertDimension).toEqual({
      range: { sheetId: 101, dimension: 'ROWS', startIndex: 5, endIndex: 7 },
      inheritFromBefore: false,
    });
    expect(topRes.requests[2].updateCells).toEqual({
      range: {
        sheetId: 101,
        startRowIndex: 6,
        endRowIndex: 7,
        startColumnIndex: 0,
        endColumnIndex: 1,
      },
      rows: [{ values: [{ userEnteredValue: { stringValue: '---' } }] }],
      fields: 'userEnteredValue',
    });

    // 2) insertMiddleNewGroup: 075100-001 between 071200-002 and 087100-001 with "---" dividers on both sides (inheritFromBefore: true)
    const midRes = scenarioResults[1];
    expect(midRes.scenario).toBe('insertMiddleNewGroup');
    expect(midRes.rowNumber).toBe(20);
    expect(midRes.action).toBe('inserted');
    expect(midRes.requests[0].insertDimension?.inheritFromBefore).toBe(true);
    expect(midRes.requests[1].updateCells?.range?.startRowIndex).toBe(18);
    expect(midRes.requests[1].updateCells?.rows?.[0]?.values).toEqual([
      { userEnteredValue: { stringValue: '---' } },
    ]);

    // 3) insertBottomNewGroup: 096500-001 after 087100-001 with leading "---" divider and zero dividers adjacent to bottom <--->
    const botRes = scenarioResults[2];
    expect(botRes.scenario).toBe('insertBottomNewGroup');
    expect(botRes.rowNumber).toBe(25);
    expect(botRes.action).toBe('inserted');
    expect(botRes.requests[0].insertDimension?.inheritFromBefore).toBe(true);
    expect(botRes.requests[1].updateCells?.range?.startRowIndex).toBe(23);
    expect(botRes.requests[1].updateCells?.rows?.[0]?.values).toEqual([
      { userEnteredValue: { stringValue: '---' } },
    ]);

    // 4) insertChronologicalMiddleInExistingGroup: 071200-001-1-260220-1 between 260212-5 and 260224-6
    const chronRes = scenarioResults[3];
    expect(chronRes.scenario).toBe('insertChronologicalMiddleInExistingGroup');
    expect(chronRes.rowNumber).toBe(15);
    expect(chronRes.action).toBe('inserted');
    expect(chronRes.requests[0].insertDimension?.inheritFromBefore).toBe(true);

    // 5) insertSameDayDuplicateIdReferral: LMD appends after PST & SME inside 071200-001 before 260212-5
    const dupRes = scenarioResults[4];
    expect(dupRes.scenario).toBe('insertSameDayDuplicateIdReferral');
    expect(dupRes.rowNumber).toBe(14);
    expect(dupRes.action).toBe('inserted');

    // Final readTable check: all 16 entries in exact sorted order, preserving leading zeros
    const finalTable = await lastSheetsClient!.readTable({
      target: {
        spreadsheetId: 'harborview-log-1',
        sheetName: sampleFixture.submittalArch.sheetName,
        rangeName: sampleFixture.submittalArch.rangeName,
        extentMarker: '<--->',
        groupDividerMarker: '---',
      },
    });

    expect(finalTable.rows).toHaveLength(16);
    const orderedKeys = finalTable.rows.map(
      (r) => `${r.values.Section}-${r.values.Number}-${r.values.Revision}-${r.values.Date}-${r.values.Contact}`
    );
    expect(orderedKeys).toEqual([
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

    // Verify raw grid has exact Column-0-only "---" dividers between adjacent groups and none adjacent to <--->
    const rawGrid = sheetsState.grid!;
    expect(rawGrid[4]).toEqual(['<--->']); // Row 5 top anchor
    expect(rawGrid[rawGrid.length - 1]).toEqual(['<--->']); // Row 28 bottom anchor
    expect(rawGrid[5][0]).not.toBe('---');
    expect(rawGrid[rawGrid.length - 2][0]).not.toBe('---');

    const dividerIndices = rawGrid
      .map((row, idx) => ({ row, idx }))
      .filter(({ row }) => row[0] === '---')
      .map(({ idx, row }) => {
        expect(row).toEqual(['---']); // strictly Column 0 only
        return idx;
      });
    expect(dividerIndices).toEqual([6, 9, 17, 20, 22, 25]);
    // Verify insertMiddleNewGroup (075100-001 at idx 21 / Row 22) is bounded by dividers at idx 20 and idx 22
    expect(rawGrid[20]).toEqual(['---']);
    expect(rawGrid[21][1]).toBe('075100');
    expect(rawGrid[22]).toEqual(['---']);
  });

  it('enforces duplicatePolicy upsert (in-place update without insertDimension) and reject (error with zero batchUpdate calls)', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const space = {
      id: sampleFixture.space.id,
      typeId: sampleFixture.space.typeId,
      name: sampleFixture.space.name,
      abstractStorageId: sampleFixture.space.abstractStorageId,
    };
    const duplicateTargetSeed = sampleFixture.submittalArch.seedEntries[2]; // 071200-001-0-260204-1 at Row 9

    // 1) duplicatePolicy: 'upsert'
    const upsertSheetsState = buildSeededSubmittalArchState();
    const upsertServiceCtx = await buildWiredDocumentService({
      driveState,
      sheetsState: upsertSheetsState,
      primaryTargetId: 'upserted-submittal-file-001',
      manifestProviderOverride: createDuplicatePolicyManifestProvider(manifestProvider, 'upsert'),
    });

    const upsertResult = await upsertServiceCtx.documentService.processDocument(
      {
        type: 'submittal-arch',
        space,
        data: {
          ...duplicateTargetSeed.documentData,
          status: 'Closed',
          notes: 'Updated terrace deck assembly notes',
        },
      },
      'onSubmit'
    );

    expect(upsertResult.success).toBe(true);
    if (!upsertResult.success) return;
    expect(upsertResult.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 9,
      action: 'updated',
    });
    expect(upsertSheetsState.batchUpdates).toHaveLength(1);
    const upsertReqs = upsertSheetsState.batchUpdates[0].requests;
    expect(upsertReqs.some((r) => r.insertDimension !== undefined)).toBe(false);
    expect(upsertReqs[0].updateCells?.range?.startRowIndex).toBe(8);

    const updatedTable = await upsertServiceCtx.sheetsClient.readTable({
      target: {
        spreadsheetId: 'harborview-log-1',
        sheetName: sampleFixture.submittalArch.sheetName,
        rangeName: sampleFixture.submittalArch.rangeName,
        extentMarker: '<--->',
        groupDividerMarker: '---',
      },
    });
    expect(updatedTable.rows).toHaveLength(11);
    expect(updatedTable.rows[2]).toEqual({
      rowNumber: 9,
      values: {
        Status: 'Closed',
        Section: '071200',
        Number: '001',
        Revision: '0',
        Title: 'Fluid-Applied Waterproofing Membrane',
        Date: '260204',
        Contact: 'MB',
        Action: 'Received',
        Notes: 'Updated terrace deck assembly notes',
        'Calc Link': 'Link',
      },
    });

    // 2) duplicatePolicy: 'reject'
    const rejectSheetsState = buildSeededSubmittalArchState();
    const rejectServiceCtx = await buildWiredDocumentService({
      driveState,
      sheetsState: rejectSheetsState,
      primaryTargetId: 'rejected-submittal-file-001',
      manifestProviderOverride: createDuplicatePolicyManifestProvider(manifestProvider, 'reject'),
    });

    const rejectResult = await rejectServiceCtx.documentService.processDocument(
      {
        type: 'submittal-arch',
        space,
        data: duplicateTargetSeed.documentData,
      },
      'onSubmit'
    );

    expect(rejectResult.success).toBe(false);
    if (!rejectResult.success) {
      expect(rejectResult.errors[0]).toMatch(/duplicate/i);
      expect(rejectResult.errors[0]).toContain('071200-001-0-260204-1');
    }
    expect(rejectSheetsState.batchUpdates).toHaveLength(0);
    expect(rejectServiceCtx.sheetsSdk.spreadsheets.batchUpdate).not.toHaveBeenCalled();
  });

  describe('Submittal FF&E (FileSubmittalFFE) & Formula-Row Protection Integration (Issue #342)', () => {
    const ffeFormula =
      '=ARRAYFORMULA(IF(B6:B="","",VLOOKUP(B6:B,Options_Submittal_FFE_Specs,2,FALSE)))';

    function buildSeededSubmittalFfeState(): MockSheetsState {
      const grid: SimCellValue[][] = [
        [], // Row 1
        [], // Row 2
        [...sampleFixture.submittalFfe.headers], // Row 3 Headers
        ['Formula Row', null, null, null, ffeFormula], // Row 4 Formula Row
        ['<--->'], // Row 5 Top Anchor
      ];

      let previousGroupId: string | undefined;
      for (let i = 0; i < sampleFixture.submittalFfe.seedEntries.length; i++) {
        const entry = sampleFixture.submittalFfe.seedEntries[i];
        if (previousGroupId !== undefined && previousGroupId !== entry.identity.idGroup) {
          grid.push(['---']);
        }
        previousGroupId = entry.identity.idGroup;
        const d = entry.documentData;
        grid.push([
          String(d.status ?? ''),
          String(d.specTag ?? ''),
          typeof d.relatedTag === 'string' && d.relatedTag.length > 0 ? d.relatedTag : null,
          String(d.revision ?? ''),
          `=SPILL_SPEC_TITLE_${i}`,
          String(d.vendor ?? ''),
          String(d.date ?? ''),
          String(d.contact ?? ''),
          entry.actionName,
          typeof d.notes === 'string' && d.notes.length > 0 ? d.notes : null,
          entry.fileUri ? `=HYPERLINK("${entry.fileUri}", "Link")` : null,
        ]);
      }
      grid.push(['<--->']); // Bottom Anchor

      return {
        tableValues: [],
        batchUpdates: [],
        grid,
        namedRange: {
          namedRangeId: 'nr-ffe',
          name: sampleFixture.submittalFfe.rangeName,
          range: {
            sheetId: 102,
            startRowIndex: 2,
            endRowIndex: grid.length,
            startColumnIndex: 0,
            endColumnIndex: sampleFixture.submittalFfe.headers.length,
          },
        },
      };
    }

    it('executes FileSubmittalFFE into cleared template protecting Row-4 Spec Title ARRAYFORMULA and keeping optional blank relatedTag empty', async () => {
      const driveState: MockDriveState = {
        searchResults: [
          {
            id: 'harborview-log-1',
            name: sampleFixture.space.expectedLogFileName,
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
        ],
      };
      const grid: SimCellValue[][] = [
        [], // Row 1
        [], // Row 2
        [...sampleFixture.submittalFfe.headers], // Row 3 Headers
        ['Formula Row', null, null, null, ffeFormula], // Row 4 Formula Row
        ['<--->'], // Row 5 Top Anchor
        [null, null, null, null, '=SPILL_EMPTY'], // Row 6 Cleared Placeholder Row (empty formatted spill untouched)
        ['<--->'], // Row 7 Bottom Anchor
      ];
      const sheetsState: MockSheetsState = {
        tableValues: [],
        batchUpdates: [],
        grid,
        namedRange: {
          namedRangeId: 'nr-ffe',
          name: sampleFixture.submittalFfe.rangeName,
          range: {
            sheetId: 102,
            startRowIndex: 2,
            endRowIndex: grid.length,
            startColumnIndex: 0,
            endColumnIndex: 11,
          },
        },
      };

      const { documentService, sheetsClient } = await buildWiredDocumentService({
        driveState,
        sheetsState,
        primaryTargetId: 'fixture-ffe-ac102-0-rec',
      });

      const topScenario = sampleFixture.submittalFfe.writeScenarios[0];
      const result = await documentService.processDocument(
        {
          type: 'submittal-ffe',
          space: {
            id: sampleFixture.space.id,
            typeId: sampleFixture.space.typeId,
            name: sampleFixture.space.name,
            abstractStorageId: sampleFixture.space.abstractStorageId,
          },
          data: topScenario.documentData,
        },
        'onSubmit'
      );

      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
      expect(result.contextVariables?.documentLogWrite).toEqual({
        spreadsheetId: 'harborview-log-1',
        sheetName: 'Submittal FF&E',
        rowNumber: 6,
        action: 'inserted',
      });

      expect(sheetsState.batchUpdates).toHaveLength(1);
      const updateReqs = sheetsState.batchUpdates[0].requests.filter((r) => r.updateCells);
      expect(updateReqs.map((r) => r.updateCells?.range)).toEqual([
        { sheetId: 102, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 0, endColumnIndex: 4 },
        { sheetId: 102, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 5, endColumnIndex: 11 },
      ]);
      // Related Tag (col 2) is blank ({}), Spec Title (col 4) spill is untouched, Calc Link has =HYPERLINK
      expect(updateReqs[0].updateCells?.rows?.[0]?.values?.[2]).toEqual({});
      expect(grid[5][4]).toBe('=SPILL_EMPTY');
      expect(grid[5][10]).toBe(
        '=HYPERLINK("https://drive.google.com/file/d/fixture-ffe-ac102-0-rec/view", "Link")'
      );

      const table = await sheetsClient.readTable({
        target: {
          spreadsheetId: 'harborview-log-1',
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });
      expect(table.formulaColumns).toEqual(['Spec Title']);
      expect(table.rows).toHaveLength(1);
      expect(table.rows[0].values['Related Tag']).toBe('');
    });

    it('executes all 3 submittalFfe.writeScenarios sequentially with grouped/sorted placement, dividers, optional relatedTag, and Spec Title ARRAYFORMULA protection', async () => {
      const driveState: MockDriveState = {
        searchResults: [
          {
            id: 'harborview-log-1',
            name: sampleFixture.space.expectedLogFileName,
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
        ],
      };
      const sheetsState = buildSeededSubmittalFfeState();
      const space = {
        id: sampleFixture.space.id,
        typeId: sampleFixture.space.typeId,
        name: sampleFixture.space.name,
        abstractStorageId: sampleFixture.space.abstractStorageId,
      };

      const scenarioResults: Array<{
        scenario: string;
        rowNumber: number;
        action: string;
        requests: MockBatchRequest[];
      }> = [];

      let lastSheetsClient: GoogleSheetsClient | undefined;

      for (const scenario of sampleFixture.submittalFfe.writeScenarios) {
        const fileIdMatch = /\/d\/([^/]+)\//.exec(scenario.fileUri);
        const fileId = fileIdMatch?.[1];
        if (!fileId) {
          throw new Error(`Missing Drive fileId in fixture fileUri: ${scenario.fileUri}`);
        }

        const { documentService, sheetsClient } = await buildWiredDocumentService({
          driveState,
          sheetsState,
          primaryTargetId: fileId,
        });
        lastSheetsClient = sheetsClient;

        const result = await documentService.processDocument(
          {
            type: 'submittal-ffe',
            space,
            data: scenario.documentData,
          },
          'onSubmit'
        );

        expect(result.success, `Scenario ${scenario.scenario} failed`).toBe(true);
        if (!result.success) return;

        expect(result.activities.map((a) => a.type)).toEqual(['MOVE_FILE', 'WRITE_LOG']);
        const writeInfo = result.contextVariables?.documentLogWrite as {
          rowNumber: number;
          action: string;
        };
        const requests = sheetsState.batchUpdates[sheetsState.batchUpdates.length - 1].requests;

        // Every write emits minimal contiguous runs skipping Column 4 (Spec Title)
        const dataUpdates = requests.filter(
          (r) => r.updateCells && (r.updateCells.range?.endColumnIndex ?? 0) > 1
        );
        expect(
          dataUpdates.map((r) => [
            r.updateCells?.range?.startColumnIndex,
            r.updateCells?.range?.endColumnIndex,
          ])
        ).toEqual([
          [0, 4],
          [5, 11],
        ]);

        scenarioResults.push({
          scenario: scenario.scenario,
          rowNumber: writeInfo.rowNumber,
          action: writeInfo.action,
          requests,
        });
      }

      // 1) insertTopNewGroup (AC102 before CG104): Row 6, inheritFromBefore: false, Column-0 "---" at Row 7
      expect(scenarioResults[0].scenario).toBe('insertTopNewGroup');
      expect(scenarioResults[0].rowNumber).toBe(6);
      expect(scenarioResults[0].requests[0].insertDimension?.inheritFromBefore).toBe(false);

      // 2) insertMiddleNewGroup (CP119 between CG104 and FB127): Row 12
      expect(scenarioResults[1].scenario).toBe('insertMiddleNewGroup');
      expect(scenarioResults[1].rowNumber).toBe(12);
      expect(scenarioResults[1].requests[0].insertDimension?.inheritFromBefore).toBe(true);

      // 3) insertIntoExistingGroupWithRelatedTag (CG104-1-260205-1 between CG104-0-260128-5 and CG104-1-260210-6): Row 10
      expect(scenarioResults[2].scenario).toBe('insertIntoExistingGroupWithRelatedTag');
      expect(scenarioResults[2].rowNumber).toBe(10);
      expect(scenarioResults[2].requests[0].insertDimension?.inheritFromBefore).toBe(true);

      const finalTable = await lastSheetsClient!.readTable({
        target: {
          spreadsheetId: 'harborview-log-1',
          sheetName: sampleFixture.submittalFfe.sheetName,
          rangeName: sampleFixture.submittalFfe.rangeName,
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });

      expect(finalTable.formulaColumns).toEqual(['Spec Title']);
      expect(finalTable.rows).toHaveLength(12);
      expect(
        finalTable.rows.map(
          (r) =>
            `${r.values['Spec Tag']}-${r.values.Revision}-${r.values.Date}-${r.values.Contact}|${r.values['Related Tag'] ?? ''}`
        )
      ).toEqual([
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

      // All pre-seeded =SPILL_SPEC_TITLE_* cells and Row-4 ARRAYFORMULA remain completely untouched
      expect(sheetsState.grid![3][4]).toBe(ffeFormula);
      const spilledValues = sheetsState.grid!
        .map((row) => row[4])
        .filter((cell) => typeof cell === 'string' && cell.startsWith('=SPILL_SPEC_TITLE_'));
      expect(spilledValues).toHaveLength(9);
    });

    it('protects reordered headers, custom user helper columns, and custom Row-4 formula columns on both insert and upsert for Submittal FF&E', async () => {
      const driveState: MockDriveState = {
        searchResults: [
          {
            id: 'harborview-log-1',
            name: sampleFixture.space.expectedLogFileName,
            mimeType: 'application/vnd.google-apps.spreadsheet',
          },
        ],
      };

      const customHeaders = [
        'Status',
        'User Helper',
        'Spec Tag',
        'Revision',
        'Custom Calc',
        'Vendor',
        'Date',
        'Contact',
        'Action',
        'Spec Title',
        'Related Tag',
        'Notes',
        'Calc Link',
      ];
      const seedEntry = sampleFixture.submittalFfe.seedEntries[0]; // CG104-0-260120-1
      const grid: SimCellValue[][] = [
        [], // Row 1
        [], // Row 2
        customHeaders, // Row 3
        ['Formula Row', null, null, null, '=ARRAYFORMULA(C6:C&"-"&D6:D)', null, null, null, null, ffeFormula], // Row 4
        ['<--->'], // Row 5
        [
          'Open',
          'user-keep-1',
          'CG104',
          '0',
          '=CUSTOM_CALC_ROW6',
          'Keystone Casegoods',
          '260120',
          'HPG',
          'Received',
          '=SPILL_TITLE_ROW6',
          'FB127',
          'Original note',
          `=HYPERLINK("${seedEntry.fileUri}", "Link")`,
        ], // Row 6
        ['<--->'], // Row 7
      ];

      const makeCustomSheetsState = (): MockSheetsState => ({
        tableValues: [],
        batchUpdates: [],
        grid: structuredClone(grid),
        namedRange: {
          namedRangeId: 'nr-ffe',
          name: sampleFixture.submittalFfe.rangeName,
          range: {
            sheetId: 102,
            startRowIndex: 2,
            endRowIndex: grid.length,
            startColumnIndex: 0,
            endColumnIndex: customHeaders.length,
          },
        },
      });

      const space = {
        id: sampleFixture.space.id,
        typeId: sampleFixture.space.typeId,
        name: sampleFixture.space.name,
        abstractStorageId: sampleFixture.space.abstractStorageId,
      };

      // 1) insert with reordered headers, User Helper (col 1), Custom Calc (col 4), Spec Title (col 9)
      const insertSheetsState = makeCustomSheetsState();
      const insertCtx = await buildWiredDocumentService({
        driveState,
        sheetsState: insertSheetsState,
        primaryTargetId: 'fixture-ffe-cg104-1-rec',
      });
      const insertScenario = sampleFixture.submittalFfe.writeScenarios[2];
      const insertRes = await insertCtx.documentService.processDocument(
        {
          type: 'submittal-ffe',
          space,
          data: insertScenario.documentData,
        },
        'onSubmit'
      );
      expect(insertRes.success).toBe(true);
      const insertUpdates = insertSheetsState.batchUpdates[0].requests.filter((r) => r.updateCells);
      expect(
        insertUpdates.map((r) => [
          r.updateCells?.range?.startColumnIndex,
          r.updateCells?.range?.endColumnIndex,
        ])
      ).toEqual([
        [0, 1], // Status
        [2, 4], // Spec Tag, Revision (skips col 1 User Helper)
        [5, 9], // Vendor, Date, Contact, Action (skips col 4 Custom Calc)
        [10, 13], // Related Tag, Notes, Calc Link (skips col 9 Spec Title)
      ]);
      expect(insertSheetsState.grid![6][1]).toBeNull();
      expect(insertSheetsState.grid![6][4]).toBeNull();
      expect(insertSheetsState.grid![6][9]).toBeNull();

      // 2) upsert in place on Row 6 -> preserves User Helper, Custom Calc, and Spec Title
      const upsertSheetsState = makeCustomSheetsState();
      const upsertCtx = await buildWiredDocumentService({
        driveState,
        sheetsState: upsertSheetsState,
        primaryTargetId: 'upserted-ffe-file',
        manifestProviderOverride: createDuplicatePolicyManifestProvider(
          manifestProvider,
          'upsert',
          'submittal-ffe'
        ),
      });
      const upsertRes = await upsertCtx.documentService.processDocument(
        {
          type: 'submittal-ffe',
          space,
          data: {
            ...seedEntry.documentData,
            status: 'Closed',
            notes: 'Updated notes via upsert',
          },
        },
        'onSubmit'
      );
      expect(upsertRes.success).toBe(true);
      if (!upsertRes.success) return;
      expect(upsertRes.contextVariables?.documentLogWrite).toEqual({
        spreadsheetId: 'harborview-log-1',
        sheetName: 'Submittal FF&E',
        rowNumber: 6,
        action: 'updated',
      });

      const upsertReqs = upsertSheetsState.batchUpdates[0].requests;
      expect(upsertReqs.some((r) => r.insertDimension)).toBe(false);
      expect(
        upsertReqs.map((r) => [
          r.updateCells?.range?.startColumnIndex,
          r.updateCells?.range?.endColumnIndex,
        ])
      ).toEqual([
        [0, 1],
        [2, 4],
        [5, 9],
        [10, 13],
      ]);
      expect(upsertSheetsState.grid![5][0]).toBe('Closed');
      expect(upsertSheetsState.grid![5][1]).toBe('user-keep-1');
      expect(upsertSheetsState.grid![5][4]).toBe('=CUSTOM_CALC_ROW6');
      expect(upsertSheetsState.grid![5][9]).toBe('=SPILL_TITLE_ROW6');
      expect(upsertSheetsState.grid![5][11]).toBe('Updated notes via upsert');

      const readRes = await upsertCtx.sheetsClient.readTable({
        target: {
          spreadsheetId: 'harborview-log-1',
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
      });
      expect(readRes.formulaColumns).toEqual(['Custom Calc', 'Spec Title']);
    });
  });

  function partialRowToSimCells(row: FixturePartialHydrationRow): SimCellValue[] {
    return sampleFixture.submittalArch.headers.map((header) => {
      if (header === 'Calc Link') {
        return row.linkFormula.length > 0 ? row.linkFormula : null;
      }
      const val = row.rowCells[header];
      return typeof val === 'string' && val.length > 0 ? val : null;
    });
  }

  function seedEntryToSimCells(entry: FixtureSubmittalEntry): SimCellValue[] {
    const d = entry.documentData;
    return [
      String(d.status ?? ''),
      String(d.section ?? ''),
      String(d.number ?? ''),
      String(d.revision ?? ''),
      String(d.title ?? ''),
      String(d.date ?? ''),
      String(d.contact ?? ''),
      entry.actionName,
      typeof d.notes === 'string' && d.notes.length > 0 ? d.notes : null,
      entry.fileUri ? `=HYPERLINK("${entry.fileUri}", "Link")` : null,
    ];
  }

  it('preserves partialHydrationRows and unkeyable malformed rows while applying localized boundary/internal healing without disturbing unrelated messy gaps', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const space = {
      id: sampleFixture.space.id,
      typeId: sampleFixture.space.typeId,
      name: sampleFixture.space.name,
      abstractStorageId: sampleFixture.space.abstractStorageId,
    };

    const [partialShortSec, partialUnknownAction, partialMissingDate] =
      sampleFixture.submittalArch.partialHydrationRows;
    const seeds = sampleFixture.submittalArch.seedEntries;

    const messyGrid: SimCellValue[][] = [
      [], // Row 1
      [], // Row 2
      [...sampleFixture.submittalArch.headers], // Row 3 Headers
      [], // Row 4 Formula Row
      ['<--->'], // idx 4 (Row 5 Top Anchor)
      ['---'], // idx 5: stray top divider (unrelated during 071200-001 edit)
      [], // idx 6: stray top blank (unrelated during 071200-001 edit)
      ['Open', '', '', '', 'Unkeyable top human note row', '', '', '', 'Follow up', null], // idx 7: null-keyed top row
      seedEntryToSimCells(seeds[0]), // idx 8: 033000-001-0-260115-1
      seedEntryToSimCells(seeds[1]), // idx 9: 033000-001-0-260122-7 (missing divider below!)
      seedEntryToSimCells(seeds[2]), // idx 10: 071200-001-0-260204-1
      [], // idx 11: accidental blank trapped inside 071200-001
      ['---'], // idx 12: accidental divider trapped inside 071200-001
      ['Open', '', '', '', 'Unkeyable trapped note inside 071200-001', '', '', '', '', null], // idx 13: null-keyed trapped row
      seedEntryToSimCells(seeds[3]), // idx 14: 071200-001-0-260205-2
      partialRowToSimCells(partialMissingDate), // idx 15: 071200-001-1--2 (partialHydrationRow)
      seedEntryToSimCells(seeds[6]), // idx 16: 071200-001-1-260224-6
      partialRowToSimCells(partialUnknownAction), // idx 17: 071200-001-1-260226- (partialHydrationRow)
      [], // idx 18: excess blank in 071200-001..071200-002 gap
      ['---'], // idx 19: divider 1 in 071200-001..071200-002 gap
      ['---'], // idx 20: duplicate divider 2 in 071200-001..071200-002 gap
      seedEntryToSimCells(seeds[7]), // idx 21: 071200-002-0-260218-1
      seedEntryToSimCells(seeds[8]), // idx 22: 071200-002-0-260219-2
      ['---'], // idx 23: unrelated messy gap divider 1
      ['---'], // idx 24: unrelated messy gap divider 2
      [], // idx 25: unrelated messy gap blank
      seedEntryToSimCells(seeds[9]), // idx 26: 087100-001-0-260303-1
      ['---'], // idx 27: divider before 7120-001
      partialRowToSimCells(partialShortSec), // idx 28: 7120-001 (partialHydrationRow)
      ['---'], // idx 29: unrelated stray bottom divider
      ['<--->'], // idx 30 Bottom Anchor
    ];

    const sheetsState: MockSheetsState = {
      tableValues: [],
      batchUpdates: [],
      grid: messyGrid,
      namedRange: {
        namedRangeId: 'nr-arch',
        name: sampleFixture.submittalArch.rangeName,
        range: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: messyGrid.length,
          startColumnIndex: 0,
          endColumnIndex: 10,
        },
      },
    };

    const runScenario = async (scenario: FixtureWriteScenario) => {
      const fileId = /\/d\/([^/]+)\//.exec(scenario.fileUri)?.[1] ?? 'file-default';
      const { documentService, sheetsClient } = await buildWiredDocumentService({
        driveState,
        sheetsState,
        primaryTargetId: fileId,
      });
      const result = await documentService.processDocument(
        {
          type: 'submittal-arch',
          space,
          data: scenario.documentData,
        },
        'onSubmit'
      );
      expect(result.success, `Scenario ${scenario.scenario} failed`).toBe(true);
      if (!result.success) {
        throw new Error(result.errors.join('; '));
      }
      return { result, sheetsClient };
    };

    // 1) Insert into existing messy group 071200-001 (scenario: insertChronologicalMiddleInExistingGroup)
    const chronScenario = sampleFixture.submittalArch.writeScenarios[3];
    const step1 = await runScenario(chronScenario);
    // 16 - 2 (deleted idx 11, 12) + 1 (inserted upper divider) = abs 15 -> rowNumber 16
    expect(step1.result.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 16,
      action: 'inserted',
    });

    // Verify top edge (idx 5..7) and lower unrelated messy gap (idx 22..24 after -2 net delta) were NOT disturbed!
    expect(sheetsState.grid![5]).toEqual(['---']);
    expect(sheetsState.grid![6]).toEqual([]);
    expect(sheetsState.grid![7][4]).toBe('Unkeyable top human note row');
    expect(sheetsState.grid![10]).toEqual(['---']); // healed upper divider between 033000-001 and 071200-001
    expect(sheetsState.grid![12][4]).toBe('Unkeyable trapped note inside 071200-001'); // preserved!
    expect(sheetsState.grid![15][5]).toBe('260220'); // newly inserted at rowNumber 16
    expect(sheetsState.grid![18]).toEqual(['---']); // healed single divider before 071200-002
    expect(sheetsState.grid![21]).toEqual(['---']); // untouched unrelated messy gap
    expect(sheetsState.grid![22]).toEqual(['---']); // untouched unrelated messy gap
    expect(sheetsState.grid![23]).toEqual([]); // untouched unrelated messy gap
    expect(sheetsState.grid![27]).toEqual(['---']); // untouched bottom stray divider
    expect(sheetsState.grid![28]).toEqual(['<--->']);

    // 2) Insert top new group 013300-001: heals top edge stray divider/blank, preserves null-keyed top row
    const topScenario = sampleFixture.submittalArch.writeScenarios[0];
    const step2 = await runScenario(topScenario);
    expect(step2.result.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 6,
      action: 'inserted',
    });
    expect(sheetsState.grid![4]).toEqual(['<--->']);
    expect(sheetsState.grid![5][1]).toBe('013300');
    expect(sheetsState.grid![6]).toEqual(['---']);
    expect(sheetsState.grid![7][4]).toBe('Unkeyable top human note row');

    // 3) Insert middle new group 075100-001: heals messy ['---', '---', blank] gap between 071200-002 and 087100-001
    const midScenario = sampleFixture.submittalArch.writeScenarios[1];
    const step3 = await runScenario(midScenario);
    expect(step3.result.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 23,
      action: 'inserted',
    });
    expect(sheetsState.grid![21]).toEqual(['---']);
    expect(sheetsState.grid![22][1]).toBe('075100');
    expect(sheetsState.grid![23]).toEqual(['---']);
    expect(sheetsState.grid![24][1]).toBe('087100');

    // 4) Insert at bottom past 7120-001 (using section "900000" > "7120"): heals bottom stray divider at <--->
    const bottomRes = await step3.sheetsClient.readTable({
      target: {
        spreadsheetId: 'harborview-log-1',
        sheetName: sampleFixture.submittalArch.sheetName,
        rangeName: sampleFixture.submittalArch.rangeName,
        extentMarker: '<--->',
        groupDividerMarker: '---',
      },
    });
    expect(bottomRes.rows.some((r) => r.values.Section === '7120')).toBe(true);
    expect(bottomRes.rows.some((r) => r.values.Action === 'Approved')).toBe(true);
    expect(bottomRes.rows.some((r) => r.values.Title === 'Unkeyable trapped note inside 071200-001')).toBe(true);

    // Log a submittal with section "900000" sorting after "7120-001" to verify bottom <---> edge healing
    const bottomDocResult = await (
      await buildWiredDocumentService({
        driveState,
        sheetsState,
        primaryTargetId: 'bottom-900000-file',
      })
    ).documentService.processDocument(
      {
        type: 'submittal-arch',
        space,
        data: {
          status: 'Open',
          section: '900000',
          number: '001',
          revision: '0',
          title: 'Commissioning Closeout',
          date: '260320',
          contact: 'MB',
          action: 'REC',
          notes: 'Final group past 7120',
        },
      },
      'onSubmit'
    );
    expect(bottomDocResult.success).toBe(true);
    if (!bottomDocResult.success) return;
    expect(bottomDocResult.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 29,
      action: 'inserted',
    });
    const finalGrid = sheetsState.grid!;
    expect(finalGrid[finalGrid.length - 1]).toEqual(['<--->']);
    expect(finalGrid[finalGrid.length - 2][1]).toBe('900000');
    expect(finalGrid[finalGrid.length - 3]).toEqual(['---']);
    expect(finalGrid[finalGrid.length - 4][1]).toBe('7120');
  });

  it('heals trapped blanks/dividers and immediate boundaries during duplicatePolicy upsert on a messy group', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };
    const space = {
      id: sampleFixture.space.id,
      typeId: sampleFixture.space.typeId,
      name: sampleFixture.space.name,
      abstractStorageId: sampleFixture.space.abstractStorageId,
    };
    const seeds = sampleFixture.submittalArch.seedEntries;
    const upsertTarget = seeds[6]; // 071200-001-1-260224-6

    const messyGrid: SimCellValue[][] = [
      [],
      [],
      [...sampleFixture.submittalArch.headers],
      [],
      ['<--->'], // idx 4
      seedEntryToSimCells(seeds[0]), // idx 5: 033000-001 (missing divider below!)
      seedEntryToSimCells(seeds[2]), // idx 6: 071200-001-0-260204-1
      ['---'], // idx 7: accidental divider trapped inside 071200-001
      ['Open', '', '', '', 'Unkeyable trapped note', '', '', '', '', null], // idx 8: null-keyed trapped row
      [], // idx 9: accidental blank trapped inside 071200-001
      seedEntryToSimCells(upsertTarget), // idx 10: 071200-001-1-260224-6 (upsert target!)
      ['---'], // idx 11: divider 1 before 087100-001
      ['---'], // idx 12: duplicate divider 2 before 087100-001
      seedEntryToSimCells(seeds[9]), // idx 13: 087100-001
      ['---'], // idx 14: unrelated bottom stray divider
      ['<--->'], // idx 15
    ];

    const sheetsState: MockSheetsState = {
      tableValues: [],
      batchUpdates: [],
      grid: messyGrid,
      namedRange: {
        namedRangeId: 'nr-arch',
        name: sampleFixture.submittalArch.rangeName,
        range: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: messyGrid.length,
          startColumnIndex: 0,
          endColumnIndex: 10,
        },
      },
    };

    const { documentService, sheetsClient } = await buildWiredDocumentService({
      driveState,
      sheetsState,
      primaryTargetId: 'upsert-healed-file-1',
      manifestProviderOverride: createDuplicatePolicyManifestProvider(manifestProvider, 'upsert'),
    });

    const res = await documentService.processDocument(
      {
        type: 'submittal-arch',
        space,
        data: {
          ...upsertTarget.documentData,
          status: 'Closed',
          notes: 'Upserted with healing',
        },
      },
      'onSubmit'
    );

    expect(res.success).toBe(true);
    if (!res.success) return;
    // idx 10 - 2 (deleted idx 7, 9) + 1 (inserted upper divider) = abs 9 -> rowNumber 10
    expect(res.contextVariables?.documentLogWrite).toEqual({
      spreadsheetId: 'harborview-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 10,
      action: 'updated',
    });

    expect(sheetsState.grid![6]).toEqual(['---']); // healed upper divider
    expect(sheetsState.grid![8][4]).toBe('Unkeyable trapped note'); // preserved
    expect(sheetsState.grid![9][0]).toBe('Closed');
    expect(sheetsState.grid![9][8]).toBe('Upserted with healing');
    expect(sheetsState.grid![10]).toEqual(['---']); // healed single lower divider
    expect(sheetsState.grid![12]).toEqual(['---']); // untouched unrelated bottom stray divider

    const readAfter = await sheetsClient.readTable({
      target: {
        spreadsheetId: 'harborview-log-1',
        sheetName: sampleFixture.submittalArch.sheetName,
        rangeName: sampleFixture.submittalArch.rangeName,
        extentMarker: '<--->',
        groupDividerMarker: '---',
      },
    });
    expect(readAfter.rows.find((r) => r.rowNumber === 10)?.values.Notes).toBe('Upserted with healing');
  });
});

describe('Resilient READ_LOG Hydration & Workflow Integration (Issue #348)', () => {
  const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
  let manifestProvider: AppManifestProvider;
  let handlebars: HandlebarsAdapter;

  beforeEach(() => {
    manifestProvider = new AppManifestProvider({ manifestPath });
    handlebars = new HandlebarsAdapter();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const space = {
    id: sampleFixture.space.id,
    typeId: sampleFixture.space.typeId,
    name: sampleFixture.space.name,
    abstractStorageId: sampleFixture.space.abstractStorageId,
  };

  function toSimCellsByHeaders(
    headers: readonly string[],
    values: Record<string, string>,
    linkFormula: string
  ): SimCellValue[] {
    return headers.map((header) => {
      if (header === 'Calc Link') {
        return linkFormula.length > 0 ? linkFormula : null;
      }
      const val = values[header];
      return typeof val === 'string' && val.length > 0 ? val : null;
    });
  }

  function buildArchReadGridState(): MockSheetsState {
    const headers = sampleFixture.submittalArch.headers;
    const grid: SimCellValue[][] = [
      [], // Row 1
      [], // Row 2
      [...headers], // Row 3 Headers
      [], // Row 4 Formula Row
      ['<--->'], // Row 5 Top Anchor
    ];

    let previousGroupId: string | undefined;
    for (const entry of sampleFixture.submittalArch.seedEntries) {
      if (previousGroupId !== undefined && previousGroupId !== entry.identity.idGroup) {
        grid.push(['---']);
      }
      previousGroupId = entry.identity.idGroup;
      const d = entry.documentData;
      grid.push([
        String(d.status ?? ''),
        String(d.section ?? ''),
        String(d.number ?? ''),
        String(d.revision ?? ''),
        String(d.title ?? ''),
        String(d.date ?? ''),
        String(d.contact ?? ''),
        entry.actionName,
        typeof d.notes === 'string' && d.notes.length > 0 ? d.notes : null,
        entry.fileUri ? `=HYPERLINK("${entry.fileUri}", "Link")` : null,
      ]);
    }

    const [invalidSectionPattern, unknownActionAndRawUrl, missingRequiredDate] =
      sampleFixture.submittalArch.partialHydrationRows;
    grid.push(['---']);
    grid.push(
      toSimCellsByHeaders(headers, unknownActionAndRawUrl.rowCells, unknownActionAndRawUrl.linkFormula)
    );
    grid.push(
      toSimCellsByHeaders(headers, missingRequiredDate.rowCells, missingRequiredDate.linkFormula)
    );
    grid.push(['---']);
    grid.push(
      toSimCellsByHeaders(headers, invalidSectionPattern.rowCells, invalidSectionPattern.linkFormula)
    );
    grid.push(['---']);
    // Unkeyable note row: blank Status/Section/Number/Revision/Date/Contact/Action, Title: "General note"
    grid.push([null, null, null, null, 'General note', null, null, null, null, null]);
    grid.push(['<--->']);

    return {
      tableValues: [],
      batchUpdates: [],
      grid,
      namedRange: {
        namedRangeId: 'nr-arch',
        name: sampleFixture.submittalArch.rangeName,
        range: {
          sheetId: 101,
          startRowIndex: 2,
          endRowIndex: grid.length,
          startColumnIndex: 0,
          endColumnIndex: headers.length,
        },
      },
    };
  }

  function buildFfeReadGridState(): MockSheetsState {
    const headers = sampleFixture.submittalFfe.headers;
    const ffeFormula =
      '=ARRAYFORMULA(IF(B6:B="","",VLOOKUP(B6:B,Options_Submittal_FFE_Specs,2,FALSE)))';
    const grid: SimCellValue[][] = [
      [], // Row 1
      [], // Row 2
      [...headers], // Row 3 Headers
      ['Formula Row', null, null, null, ffeFormula], // Row 4 Formula Row
      ['<--->'], // Row 5 Top Anchor
    ];

    let previousGroupId: string | undefined;
    for (const entry of sampleFixture.submittalFfe.seedEntries) {
      if (previousGroupId !== undefined && previousGroupId !== entry.identity.idGroup) {
        grid.push(['---']);
      }
      previousGroupId = entry.identity.idGroup;
      const d = entry.documentData;
      grid.push([
        String(d.status ?? ''),
        String(d.specTag ?? ''),
        typeof d.relatedTag === 'string' && d.relatedTag.length > 0 ? d.relatedTag : null,
        String(d.revision ?? ''),
        String(d.specTitle ?? ''),
        String(d.vendor ?? ''),
        String(d.date ?? ''),
        String(d.contact ?? ''),
        entry.actionName,
        typeof d.notes === 'string' && d.notes.length > 0 ? d.notes : null,
        entry.fileUri ? `=HYPERLINK("${entry.fileUri}", "Link")` : null,
      ]);
    }

    for (const partialRow of sampleFixture.submittalFfe.partialHydrationRows) {
      grid.push(['---']);
      grid.push(toSimCellsByHeaders(headers, partialRow.rowCells, partialRow.linkFormula));
    }
    grid.push(['<--->']);

    return {
      tableValues: [],
      batchUpdates: [],
      grid,
      namedRange: {
        namedRangeId: 'nr-ffe',
        name: sampleFixture.submittalFfe.rangeName,
        range: {
          sheetId: 102,
          startRowIndex: 2,
          endRowIndex: grid.length,
          startColumnIndex: 0,
          endColumnIndex: headers.length,
        },
      },
    };
  }

  it('hydrates full and filtered logs via DocumentLogPort.readLog() across submittalArch (partialHydrationRows + unkeyable row) and submittalFfe (partialHydrationRows + readOnly Spec Title)', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-log-1',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };

    // 1) Submittal Arch
    const archWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient: new GoogleDriveClient({
        drive: createMockDriveSdk(driveState),
        configProvider: manifestProvider,
      }),
      sheetsClient: new GoogleSheetsClient({
        sheets: createMockSheetsSdk(buildArchReadGridState()),
        configProvider: manifestProvider,
      }),
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await archWiring.logSchemaRegistry.initialize();

    const archFull = await archWiring.documentLogService.readLog({
      documentTypeKey: 'submittal-arch',
      space,
    });
    expect(archFull.spreadsheetId).toBe('harborview-log-1');
    expect(archFull.sheetName).toBe(sampleFixture.submittalArch.sheetName);
    expect(archFull.entries).toHaveLength(sampleFixture.submittalArch.seedEntries.length + 4);
    for (const entry of archFull.entries) {
      expect(entry.document.calculated).toBeUndefined();
      expect('calculated' in entry.document).toBe(false);
    }

    const partialShortSec = archFull.entries.find((e) => e.document.idGroup === '7120-001');
    expect(partialShortSec).toBeDefined();
    expect(partialShortSec?.valid).toBe(false);
    expect(partialShortSec?.fileUri).toBe(
      'https://drive.google.com/file/d/fixture-arch-partial-sec/view'
    );
    expect(
      archFull.warnings
        .filter((w) => w.rowNumber === partialShortSec?.rowNumber)
        .map((w) => w.field)
    ).toEqual(sampleFixture.submittalArch.partialHydrationRows[0].expectedIssues);

    const partialUnknownAction = archFull.entries.find(
      (e) => e.document.data.notes === 'Legacy human label'
    );
    expect(partialUnknownAction).toBeDefined();
    expect(partialUnknownAction?.valid).toBe(false);
    expect(partialUnknownAction?.document.data.action).toEqual({
      key: 'Approved',
      name: 'Approved',
    });
    expect(partialUnknownAction?.fileUri).toBe(
      'https://drive.google.com/file/d/fixture-arch-raw-url/view'
    );
    expect(
      archFull.warnings
        .filter((w) => w.rowNumber === partialUnknownAction?.rowNumber)
        .map((w) => w.field)
    ).toEqual(sampleFixture.submittalArch.partialHydrationRows[1].expectedIssues);

    const partialMissingDate = archFull.entries.find(
      (e) => e.document.data.notes === 'Awaiting date confirmation'
    );
    expect(partialMissingDate).toBeDefined();
    expect(partialMissingDate?.valid).toBe(false);
    expect('date' in (partialMissingDate?.document.data ?? {})).toBe(false);
    expect(partialMissingDate?.fileUri).toBeUndefined();
    expect(
      archFull.warnings
        .filter((w) => w.rowNumber === partialMissingDate?.rowNumber)
        .map((w) => w.field)
    ).toEqual(sampleFixture.submittalArch.partialHydrationRows[2].expectedIssues);

    const unkeyableNoteRow = archFull.entries.find(
      (e) => e.document.data.title === 'General note'
    );
    expect(unkeyableNoteRow).toBeDefined();
    expect(unkeyableNoteRow?.valid).toBe(false);
    expect(unkeyableNoteRow?.document.idGroup).toBeUndefined();
    expect(unkeyableNoteRow?.document.idDocument).toBeUndefined();
    expect(unkeyableNoteRow?.document.id).toBeUndefined();

    const warnedRowNumbers = new Set(archFull.warnings.map((w) => w.rowNumber));
    expect(warnedRowNumbers.has(partialShortSec!.rowNumber)).toBe(true);
    expect(warnedRowNumbers.has(partialUnknownAction!.rowNumber)).toBe(true);
    expect(warnedRowNumbers.has(partialMissingDate!.rowNumber)).toBe(true);
    expect(warnedRowNumbers.has(unkeyableNoteRow!.rowNumber)).toBe(true);

    // Filtered idGroup: [' 071200-001 ']
    const archFiltered = await archWiring.documentLogService.readLog({
      documentTypeKey: 'submittal-arch',
      space,
      filterBy: 'idGroup',
      values: [' 071200-001 '],
    });
    expect(archFiltered.entries).toHaveLength(7);
    expect(archFiltered.entries.every((e) => e.document.idGroup === '071200-001')).toBe(true);
    expect(archFiltered.entries.some((e) => e.rowNumber === partialUnknownAction?.rowNumber)).toBe(
      true
    );
    expect(archFiltered.entries.some((e) => e.rowNumber === partialMissingDate?.rowNumber)).toBe(
      true
    );
    const matchedRows = new Set(archFiltered.entries.map((e) => e.rowNumber));
    expect(archFiltered.warnings.every((w) => matchedRows.has(w.rowNumber))).toBe(true);
    expect(archFiltered.warnings.map((w) => w.field)).toEqual(['action', 'date']);
    expect(
      archFiltered.warnings.some(
        (w) =>
          w.rowNumber === partialShortSec?.rowNumber ||
          w.rowNumber === unkeyableNoteRow?.rowNumber
      )
    ).toBe(false);

    // Non-matching '-' filter returns empty entries and warnings
    const archDashFilter = await archWiring.documentLogService.readLog({
      documentTypeKey: 'submittal-arch',
      space,
      filterBy: 'idGroup',
      values: ['-'],
    });
    expect(archDashFilter.entries).toEqual([]);
    expect(archDashFilter.warnings).toEqual([]);

    // 2) Submittal FF&E
    const ffeWiring = createDocumentLogWiring({
      manifestProvider,
      driveClient: new GoogleDriveClient({
        drive: createMockDriveSdk(driveState),
        configProvider: manifestProvider,
      }),
      sheetsClient: new GoogleSheetsClient({
        sheets: createMockSheetsSdk(buildFfeReadGridState()),
        configProvider: manifestProvider,
      }),
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await ffeWiring.logSchemaRegistry.initialize();

    const ffeLt108 = await ffeWiring.documentLogService.readLog({
      documentTypeKey: 'submittal-ffe',
      space,
      filterBy: 'idGroup',
      values: 'lt108',
    });
    expect(ffeLt108.entries).toHaveLength(4);
    for (const entry of ffeLt108.entries) {
      expect(entry.document.data.specTitle).toBe('SCONCE');
    }
    const invalidStatusRow = ffeLt108.entries.find(
      (e) => e.document.data.notes === 'Pending vendor confirmation'
    );
    expect(invalidStatusRow).toBeDefined();
    expect(invalidStatusRow?.valid).toBe(false);
    expect(invalidStatusRow?.document.data.status).toEqual({ key: 'In Review' });
    expect('vendor' in (invalidStatusRow?.document.data ?? {})).toBe(false);
    expect(invalidStatusRow?.fileUri).toBe(
      'https://drive.google.com/file/d/fixture-ffe-partial-vendor/view'
    );
    // statuses is a restricted live _Config option source (#359), so "In Review" warns alongside missing required vendor
    expect(ffeLt108.warnings.map((w) => w.field)).toEqual(['status', 'vendor']);
    expect(
      invalidStatusRow?.validationErrors?.filter(
        (msg) => msg.includes('"statuses"') || msg.includes('"vendor"')
      )
    ).toHaveLength(2);

    const ffeFull = await ffeWiring.documentLogService.readLog({
      documentTypeKey: 'submittal-ffe',
      space,
    });
    expect(ffeFull.entries).toHaveLength(sampleFixture.submittalFfe.seedEntries.length + 2);
    const missingRevRow = ffeFull.entries.find(
      (e) => e.document.data.notes === 'Missing rev number'
    );
    expect(missingRevRow).toBeDefined();
    expect(missingRevRow?.valid).toBe(false);
    expect('revision' in (missingRevRow?.document.data ?? {})).toBe(false);
    expect(missingRevRow?.document.data.specTitle).toBe('BED - KING');
    expect(missingRevRow?.fileUri).toBe(
      'https://drive.google.com/file/d/fixture-ffe-raw-url/view'
    );
    expect(
      ffeFull.warnings
        .filter((w) => w.rowNumber === missingRevRow?.rowNumber)
        .map((w) => w.field)
    ).toEqual(['revision']);
    expect(missingRevRow?.validationErrors).toHaveLength(1);

    // idDocument and id filtering on Submittal FF&E
    const ffeByIdDocument = await ffeWiring.documentLogService.readLog({
      documentTypeKey: 'submittal-ffe',
      space,
      filterBy: 'idDocument',
      values: 'CG104-0',
    });
    expect(ffeByIdDocument.entries).toHaveLength(2);
    expect(ffeByIdDocument.entries.every((e) => e.document.idDocument === 'CG104-0')).toBe(true);

    const ffeById = await ffeWiring.documentLogService.readLog({
      documentTypeKey: 'submittal-ffe',
      space,
      filterBy: 'id',
      values: 'LT108-0-260215-2',
    });
    expect(ffeById.entries).toHaveLength(2);
    expect(ffeById.entries.every((e) => e.document.id === 'LT108-0-260215-2')).toBe(true);
  });

  it('executes wired DocumentService.processDocument() READ_LOG -> downstream activity reading {{Context.logEntries.0...}} and {{Context.documentLogRead.*}} while skipping Drive search when selectedLogId is forwarded', async () => {
    const driveSdk = createMockDriveSdk({ searchResults: [] });
    const sheetsSdk = createMockSheetsSdk(buildArchReadGridState());
    const driveClient = new GoogleDriveClient({
      drive: driveSdk,
      configProvider: manifestProvider,
    });
    const sheetsClient = new GoogleSheetsClient({
      sheets: sheetsSdk,
      configProvider: manifestProvider,
    });

    const lookupManifestProvider: RawManifestProviderPort = {
      getRawManifest: () => manifestProvider.getRawManifest(),
      readParsedSchema: async (relPath: string) => {
        const parsed = await manifestProvider.readParsedSchema(relPath);
        if (!relPath.includes('submittal-arch')) {
          return parsed;
        }
        const cloned = structuredClone(parsed) as Record<string, unknown>;
        const uiSchema = cloned.documentUiSchema as {
          events: Record<string, { catchAllWorkflow?: string }>;
        };
        uiSchema.events.onLookup = { catchAllWorkflow: 'LookupAndSummarize' };
        const workflowConfig = cloned.documentWorkflowConfig as {
          workflows: Array<{ name: string; activitySequence: unknown[] }>;
        };
        workflowConfig.workflows.push({
          name: 'LookupAndSummarize',
          activitySequence: [
            {
              id: 'readPrior',
              type: 'READ_LOG',
              payload: {
                filterBy: 'idGroup',
                values: ['{{Document.idGroup}}'],
              },
            },
            {
              id: 'summarize',
              type: 'CAPTURE_SUMMARY',
              payload: {
                priorTitle: '{{Context.logEntries.0.document.data.title}}',
                priorAction: '{{Context.logEntries.0.document.data.action.name}}',
                priorUri: '{{Context.logEntries.0.fileUri}}',
                firstWarningField: '{{Context.logEntriesWarnings.0.field}}',
                entryCount: '{{Context.documentLogRead.entryCount}}',
                warningCount: '{{Context.documentLogRead.warningCount}}',
              },
            },
          ],
        });
        return cloned;
      },
    };

    const docSchemaRegistry = new DocumentSchemaRegistryAdapter(
      lookupManifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const compiledRegistry = new CompiledSchemaRegistry(docSchemaRegistry);
    await compiledRegistry.initialize();

    const logWiring = createDocumentLogWiring({
      manifestProvider: lookupManifestProvider,
      driveClient,
      sheetsClient,
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const capturedSummaries: Array<Record<string, unknown>> = [];
    const captureHandler: ActivityHandler = {
      canHandle: (activity: Activity) => activity.type === 'CAPTURE_SUMMARY',
      handle: async (
        activity: Activity
      ): Promise<ActivityOutput> => {
        capturedSummaries.push(activity.payload);
        return {
          success: true,
          contextVariables: { capturedSummary: activity.payload },
        };
      },
    };

    const activityEngine = new ActivityEngine([
      logWiring.createPerRequestActivityHandler({ selectedLogId: 'harborview-log-1' }),
      captureHandler,
    ]);
    const documentService = new DocumentService(
      activityEngine,
      docSchemaRegistry,
      handlebars,
      compiledRegistry,
      undefined,
      undefined,
      'harborview-log-1',
      createStaticCsiDivisionsOptionTablePort()
    );
    await documentService.initialize();

    const targetSeed = sampleFixture.submittalArch.seedEntries[2]; // 071200-001
    const result = await documentService.processDocument(
      {
        type: 'submittal-arch',
        space,
        data: targetSeed.documentData,
      },
      'onLookup'
    );

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.activities.map((a) => a.type)).toEqual(['READ_LOG', 'CAPTURE_SUMMARY']);
    expect(capturedSummaries).toEqual([
      {
        priorTitle: 'Fluid-Applied Waterproofing Membrane',
        priorAction: 'Received',
        priorUri: 'https://drive.google.com/file/d/fixture-arch-071200-001-0-rec/view',
        firstWarningField: 'action',
        entryCount: '7',
        warningCount: '2',
      },
    ]);
    expect(driveSdk.files.list).not.toHaveBeenCalled();
  });

  it('fails fast during LogSchemaRegistryAdapter.initialize() when a DocumentType workflow uses READ_LOG without declaring documentLogSchema', async () => {
    const driveClient = new GoogleDriveClient({
      drive: createMockDriveSdk({ searchResults: [] }),
      configProvider: manifestProvider,
    });
    const sheetsClient = new GoogleSheetsClient({
      sheets: createMockSheetsSdk({ tableValues: [], batchUpdates: [] }),
      configProvider: manifestProvider,
    });

    const invalidManifestProvider: RawManifestProviderPort = {
      getRawManifest: () => manifestProvider.getRawManifest(),
      readParsedSchema: async (relPath: string) => {
        const parsed = await manifestProvider.readParsedSchema(relPath);
        if (!relPath.includes('submittal-arch')) {
          return parsed;
        }
        const cloned = structuredClone(parsed) as Record<string, unknown>;
        delete cloned.documentLogSchema;
        const docSchema = cloned.documentSchema as { optionSources?: unknown } | undefined;
        if (docSchema) {
          delete docSchema.optionSources;
        }
        const workflowConfig = cloned.documentWorkflowConfig as {
          workflows: Array<{ name: string; activitySequence: unknown[] }>;
        };
        workflowConfig.workflows = [
          {
            name: 'LookupWithoutLogSchema',
            activitySequence: [
              {
                id: 'readPrior',
                type: 'READ_LOG',
                payload: {},
              },
            ],
          },
        ];
        return cloned;
      },
    };

    const logWiring = createDocumentLogWiring({
      manifestProvider: invalidManifestProvider,
      driveClient,
      sheetsClient,
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });

    await expect(logWiring.logSchemaRegistry.initialize()).rejects.toThrow(
      DocumentLogConfigurationError
    );
    await expect(logWiring.logSchemaRegistry.initialize()).rejects.toThrow(
      /READ_LOG.*documentLogSchema/i
    );
  });

  it('serializes concurrent DocumentLogPort.writeLog() calls across separate GoogleSheetsClient instances via process-shared KeyedAsyncLock without duplicating _Config option rows (Ticket #361)', async () => {
    const spreadsheetId = 'concurrent-doclog-361';
    const logGrid: SimCellValue[][] = [
      [],
      [],
      ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'],
      ['Formula Row', '', '', '', '', '', '', '', '', ''],
      ['<--->'],
      [''],
      ['<--->'],
    ];
    const configGrid: SimCellValue[][] = [
      ['Status', '', 'Contact', 'Name', 'Contact Type', '', 'Action', 'Name', 'Suffix', 'Order'],
      ['Open', '', 'INC', 'INC Architecture and Design', 'INC', '', 'REC', 'Received', '', '1'],
      ['Closed', '', '---', '', '', '', '---', '', '', ''],
      ['---', '', '', '', '', '', '', '', '', ''],
    ];

    const namedRanges = [
      {
        namedRangeId: 'nr-log',
        name: 'Log_Submittal_Arch',
        range: { sheetId: 101, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 10 },
      },
      {
        namedRangeId: 'nr-statuses',
        name: 'Options_Submittal_Arch_Statuses',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-contacts',
        name: 'Options_Submittal_Arch_Contacts',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 2, endColumnIndex: 5 },
      },
      {
        namedRangeId: 'nr-val-contacts',
        name: 'Validation_Submittal_Arch_Contacts',
        range: { sheetId: 103, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 2, endColumnIndex: 3 },
      },
      {
        namedRangeId: 'nr-actions',
        name: 'Options_Submittal_Arch_Actions',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 6, endColumnIndex: 10 },
      },
    ];

    const sliceRange = (a1Range: string): SimCellValue[][] => {
      const sheetGrid = a1Range.includes('_Config Submittal Arch') ? configGrid : logGrid;
      const bounds = parseA1RangeBounds(a1Range, sheetGrid.length, 10);
      return sheetGrid.slice(bounds.startRowIndex, bounds.endRowIndex).map((row) => {
        const out: SimCellValue[] = [];
        for (let c = bounds.startColumnIndex; c < bounds.endColumnIndex; c++) {
          out.push(row[c] ?? '');
        }
        while (out.length > 0 && (out[out.length - 1] === '' || out[out.length - 1] === null)) {
          out.pop();
        }
        return out;
      });
    };

    let releaseFirstWrite!: () => void;
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstBatchEntered!: () => void;
    const firstBatchEnteredPromise = new Promise<void>((resolve) => {
      firstBatchEntered = resolve;
    });
    let batchCount = 0;
    const batchCallPayloads: Array<Array<Record<string, unknown>>> = [];

    const multiSheetsSdk = {
      spreadsheets: {
        get: vi.fn().mockImplementation(async () => ({
          data: {
            spreadsheetId,
            sheets: [
              { properties: { sheetId: 101, title: 'Submittal Arch' } },
              { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
            ],
            namedRanges: namedRanges.map((nr) => ({ ...nr, range: { ...nr.range } })),
          },
        })),
        values: {
          get: vi.fn().mockImplementation(async ({ range }: { range: string }) => ({
            data: { values: sliceRange(range) },
          })),
          batchGet: vi.fn().mockImplementation(async ({ ranges }: { ranges: string[] }) => ({
            data: {
              valueRanges: ranges.map((range) => ({ range, values: sliceRange(range) })),
            },
          })),
          update: vi.fn().mockResolvedValue({ data: {} }),
        },
        batchUpdate: vi.fn().mockImplementation(
          async (params: { requestBody: { requests: Array<Record<string, unknown>> } }) => {
            batchCount++;
            const currentCall = batchCount;
            batchCallPayloads.push(params.requestBody.requests);
            if (currentCall === 1) {
              firstBatchEntered();
              await firstWriteGate;
            }
            for (const req of params.requestBody.requests) {
              const insDim = req.insertDimension as
                | { range?: { sheetId?: number; startIndex?: number; endIndex?: number } }
                | undefined;
              if (insDim?.range) {
                const { sheetId, startIndex = 0, endIndex = 0 } = insDim.range;
                const grid = sheetId === 103 ? configGrid : logGrid;
                const count = endIndex - startIndex;
                for (let i = 0; i < count; i++) {
                  grid.splice(startIndex, 0, []);
                }
                for (const nr of namedRanges) {
                  if (nr.range.sheetId === sheetId && startIndex > nr.range.startRowIndex && startIndex < nr.range.endRowIndex) {
                    nr.range.endRowIndex += count;
                  }
                }
              }
              const insRange = req.insertRange as
                | { range?: { sheetId?: number; startRowIndex?: number; endRowIndex?: number; startColumnIndex?: number; endColumnIndex?: number } }
                | undefined;
              if (insRange?.range) {
                const { sheetId, startRowIndex = 0, endRowIndex = 0, startColumnIndex = 0, endColumnIndex = 0 } = insRange.range;
                const grid = sheetId === 103 ? configGrid : logGrid;
                const count = endRowIndex - startRowIndex;
                const prevLen = grid.length;
                for (let i = 0; i < count; i++) grid.push([]);
                for (let r = prevLen - 1; r >= startRowIndex; r--) {
                  for (let c = startColumnIndex; c < endColumnIndex; c++) {
                    while (grid[r + count]!.length <= c) grid[r + count]!.push('');
                    grid[r + count]![c] = grid[r]?.[c] ?? '';
                  }
                }
                for (let r = startRowIndex; r < endRowIndex; r++) {
                  for (let c = startColumnIndex; c < endColumnIndex; c++) {
                    while (grid[r]!.length <= c) grid[r]!.push('');
                    grid[r]![c] = '';
                  }
                }
                for (const nr of namedRanges) {
                  if (
                    nr.range.sheetId === sheetId &&
                    nr.range.startColumnIndex >= startColumnIndex &&
                    nr.range.endColumnIndex <= endColumnIndex &&
                    startRowIndex > nr.range.startRowIndex &&
                    startRowIndex < nr.range.endRowIndex
                  ) {
                    nr.range.endRowIndex += count;
                  }
                }
              }
              const updCells = req.updateCells as
                | {
                    range?: { sheetId?: number; startRowIndex?: number; startColumnIndex?: number };
                    rows?: Array<{ values?: Array<{ userEnteredValue?: { stringValue?: string } }> }>;
                  }
                | undefined;
              if (updCells?.range && updCells.rows) {
                const grid = updCells.range.sheetId === 103 ? configGrid : logGrid;
                const sr = updCells.range.startRowIndex ?? 0;
                const sc = updCells.range.startColumnIndex ?? 0;
                updCells.rows.forEach((row, rOff) => {
                  while (grid.length <= sr + rOff) grid.push([]);
                  const targetRow = grid[sr + rOff]!;
                  (row.values ?? []).forEach((cell, cOff) => {
                    while (targetRow.length <= sc + cOff) targetRow.push('');
                    if (cell.userEnteredValue?.stringValue !== undefined) {
                      targetRow[sc + cOff] = cell.userEnteredValue.stringValue;
                    }
                  });
                });
              }
              const updNr = req.updateNamedRange as
                | { namedRange?: { namedRangeId?: string; range?: { startRowIndex?: number; endRowIndex?: number } } }
                | undefined;
              if (updNr?.namedRange?.namedRangeId && updNr.namedRange.range) {
                const existing = namedRanges.find((nr) => nr.namedRangeId === updNr.namedRange!.namedRangeId);
                if (existing) {
                  existing.range.startRowIndex = updNr.namedRange.range.startRowIndex ?? existing.range.startRowIndex;
                  existing.range.endRowIndex = updNr.namedRange.range.endRowIndex ?? existing.range.endRowIndex;
                }
              }
            }
            return { data: {} };
          }
        ),
      },
    } as unknown as NonNullable<GoogleSheetsClientOptions['sheets']>;

    const driveClient = new GoogleDriveClient({
      drive: createMockDriveSdk({
        searchResults: [{ id: spreadsheetId, name: 'Harborview Hotel Document Log', parents: ['folder-1'] }],
      }),
      configProvider: manifestProvider,
    });

    // Two distinct GoogleSheetsClient instances (mirroring per-request OAuth clients)
    const wiring1 = createDocumentLogWiring({
      manifestProvider,
      driveClient,
      sheetsClient: new GoogleSheetsClient({ sheets: multiSheetsSdk, configProvider: manifestProvider }),
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    const wiring2 = createDocumentLogWiring({
      manifestProvider,
      driveClient,
      sheetsClient: new GoogleSheetsClient({ sheets: multiSheetsSdk, configProvider: manifestProvider }),
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await Promise.all([
      wiring1.logSchemaRegistry.initialize(),
      wiring2.logSchemaRegistry.initialize(),
    ]);

    const space = {
      id: sampleFixture.space.id,
      typeId: sampleFixture.space.typeId,
      name: sampleFixture.space.name,
      abstractStorageId: sampleFixture.space.abstractStorageId,
    };

    const write1Promise = wiring1.documentLogService.writeLog({
      document: {
        type: 'submittal-arch',
        space,
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '0',
          title: 'First Submittal',
          date: '260204',
          contact: 'Acme Builders',
          action: 'REC',
        },
      },
    });

    await firstBatchEnteredPromise;

    const write2Promise = wiring2.documentLogService.writeLog({
      document: {
        type: 'submittal-arch',
        space,
        data: {
          status: 'Open',
          section: '071200',
          number: '002',
          revision: '0',
          title: 'Second Submittal',
          date: '260204',
          contact: 'acme builders',
          action: 'REC',
        },
      },
    });

    releaseFirstWrite();
    const [res1, res2] = await Promise.all([write1Promise, write2Promise]);

    expect(res1.action).toBe('inserted');
    expect(res2.action).toBe('inserted');
    expect(batchCallPayloads).toHaveLength(2);
    // First batch inserts Acme Builders into _Config; second batch sees it inside lock and emits 0 _Config mutations
    expect(batchCallPayloads[0].some((r) => 'insertRange' in r)).toBe(true);
    expect(batchCallPayloads[1].some((r) => 'insertRange' in r)).toBe(false);

    // Only ONE Acme Builders row exists above '---' (never duplicated), Contact Type left blank
    const contactsNr = namedRanges.find((nr) => nr.name === 'Options_Submittal_Arch_Contacts')!;
    const contactRows = configGrid
      .slice(contactsNr.range.startRowIndex, contactsNr.range.endRowIndex)
      .map((r) => r.slice(2, 5));
    expect(contactRows).toEqual([
      ['Contact', 'Name', 'Contact Type'],
      ['INC', 'INC Architecture and Design', 'INC'],
      ['Acme Builders', 'Acme Builders', ''],
      ['---', '', ''],
    ]);
    // Validation_Submittal_Arch_Contacts expanded from endRowIndex 2 -> 3 (not 4)
    expect(namedRanges.find((nr) => nr.name === 'Validation_Submittal_Arch_Contacts')?.range).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 3,
    });
    // Neighboring tables unshifted
    expect(configGrid[3][0]).toBe('---');
    expect(configGrid[2][6]).toBe('---');
    // Both submittal rows written to Log_Submittal_Arch
    expect(logGrid.filter((r) => r[0] === 'Open')).toHaveLength(2);
  });

  it('hydrates restricted dynamic LookupFields (status, action) against live customized _Config tables so live matches hydrate valid:true with live Identity while default-only values emit RowHydrationWarnings (Ticket #359)', async () => {
    const driveState: MockDriveState = {
      searchResults: [
        {
          id: 'harborview-custom-config-log',
          name: sampleFixture.space.expectedLogFileName,
          mimeType: 'application/vnd.google-apps.spreadsheet',
        },
      ],
    };

    const baseState = buildArchReadGridState();
    const customGrid: SimCellValue[][] = [
      [],
      [],
      [...sampleFixture.submittalArch.headers],
      [],
      ['<--->'],
      [
        'In Review',
        '071200',
        '001',
        '0',
        'Live Custom Config Entry',
        '261125',
        'PMG',
        'Custom Action',
        '',
        '=HYPERLINK("https://drive.google.com/file/d/custom-valid/view", "Link")',
      ],
      [
        'Open',
        '071200',
        '001',
        '1',
        'Default Status Only Entry',
        '261125',
        'PMG',
        'Custom Action',
        '',
        null,
      ],
      [
        'In Review',
        '071200',
        '001',
        '2',
        'Default Action Only Entry',
        '261125',
        'PMG',
        'Received',
        '',
        null,
      ],
      ['<--->'],
    ];

    const customSheetsState: MockSheetsState = {
      ...baseState,
      grid: customGrid,
      namedRange: {
        ...baseState.namedRange!,
        range: {
          ...baseState.namedRange!.range,
          endRowIndex: customGrid.length,
        },
      },
      archStatusesRows: [['Status'], ['In Review'], ['---']],
      archActionsRows: [
        ['Action', 'Name', 'Suffix', 'Order'],
        ['CUST', 'Custom Action', '_CUST', '9'],
        ['---', '', '', ''],
      ],
    };

    const wiring = createDocumentLogWiring({
      manifestProvider,
      driveClient: new GoogleDriveClient({
        drive: createMockDriveSdk(driveState),
        configProvider: manifestProvider,
      }),
      sheetsClient: new GoogleSheetsClient({
        sheets: createMockSheetsSdk(customSheetsState),
        configProvider: manifestProvider,
      }),
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await wiring.logSchemaRegistry.initialize();

    const readResult = await wiring.documentLogService.readLog({
      documentTypeKey: 'submittal-arch',
      space,
    });

    expect(readResult.entries).toHaveLength(3);

    const validEntry = readResult.entries.find(
      (e) => e.document.data.title === 'Live Custom Config Entry'
    );
    expect(validEntry).toBeDefined();
    expect(validEntry?.valid).toBe(true);
    expect(validEntry?.document.data.status).toEqual({ key: 'In Review' });
    expect(validEntry?.document.data.action).toEqual({
      key: 'CUST',
      name: 'Custom Action',
      suffix: '_CUST',
      order: '9',
    });
    expect(validEntry?.document.id).toBe('071200-001-0-261125-9');
    expect(validEntry?.fileUri).toBe('https://drive.google.com/file/d/custom-valid/view');

    const invalidStatusEntry = readResult.entries.find(
      (e) => e.document.data.title === 'Default Status Only Entry'
    );
    expect(invalidStatusEntry?.valid).toBe(false);
    expect(invalidStatusEntry?.document.data.status).toEqual({ key: 'Open' });
    expect(
      readResult.warnings
        .filter((w) => w.rowNumber === invalidStatusEntry?.rowNumber)
        .map((w) => w.field)
    ).toEqual(['status']);

    const invalidActionEntry = readResult.entries.find(
      (e) => e.document.data.title === 'Default Action Only Entry'
    );
    expect(invalidActionEntry?.valid).toBe(false);
    expect(invalidActionEntry?.document.data.action).toEqual({
      key: 'Received',
      name: 'Received',
    });
    expect(
      readResult.warnings
        .filter((w) => w.rowNumber === invalidActionEntry?.rowNumber)
        .map((w) => w.field)
    ).toEqual(['action']);

    expect(readResult.warnings).toHaveLength(2);

    const uiContext = await wiring.documentLogService.queryUiContext({
      documentTypeKey: 'submittal-arch',
      space,
      formData: {
        [getDocumentInfoWidgetName('section', 'submittal-arch')]: '071200',
        [getDocumentInfoWidgetName('number', 'submittal-arch')]: '001',
      },
    });
    expect(uiContext?.status).toBe('resolved');
    if (uiContext?.status === 'resolved') {
      expect(uiContext.readStatus).toBe('partial_hydration');
      expect(uiContext.warningMessages).toHaveLength(2);
      expect(uiContext.entries).toHaveLength(3);
    }
  });

  it('reads _Config option tables via DocumentLogPort + GoogleSheetsClient, parsing RFC 4180 aliasesColumn cells with "" escaped quotes and silently ignoring absent Aliases headers (Ticket #360)', async () => {
    const driveClient = new GoogleDriveClient({
      drive: createMockDriveSdk({
        searchResults: [{ id: 'log-360-sheet', name: 'Harborview Document Log' }],
      }),
      configProvider: manifestProvider,
    });

    const mockSheets = {
      spreadsheets: {
        get: vi.fn().mockResolvedValue({
          data: {
            spreadsheetId: 'log-360-sheet',
            sheets: [{ properties: { sheetId: 201, title: '_Config' } }],
            namedRanges: [
              {
                namedRangeId: 'nr-contacts',
                name: 'Options_Contacts',
                range: { sheetId: 201, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 3 },
              },
              {
                namedRangeId: 'nr-vendors',
                name: 'Options_Vendors',
                range: { sheetId: 201, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 4, endColumnIndex: 6 },
              },
            ],
          },
        }),
        batchUpdate: vi.fn(),
        values: {
          get: vi.fn(),
          batchGet: vi.fn().mockResolvedValue({
            data: {
              valueRanges: [
                {
                  values: [
                    ['Contact', 'Name', 'Aliases'],
                    ['PMG', 'Pavarini McGovern', '"Pavarini, McGovern", "ACME ""Corp""", PCNE, @pavarini.com'],
                    ['INC', 'INC Architecture', ''],
                    ['---', '', ''],
                  ],
                },
                {
                  values: [
                    ['Vendor', 'Name'],
                    ['CARN', 'Carnegie Fabrics'],
                    ['---', ''],
                  ],
                },
              ],
            },
          }),
          update: vi.fn(),
        },
      },
    } as unknown as NonNullable<GoogleSheetsClientOptions['sheets']>;

    const sheetsClient = new GoogleSheetsClient({
      sheets: mockSheets,
      configProvider: manifestProvider,
    });

    const customManifestProvider: RawManifestProviderPort = {
      getRawManifest: () => manifestProvider.getRawManifest(),
      readParsedSchema: async (relPath: string) => {
        const parsed = await manifestProvider.readParsedSchema(relPath);
        if (!relPath.includes('submittal-arch')) {
          return parsed;
        }
        const cloned = structuredClone(parsed) as Record<string, unknown>;
        const docSchema = cloned.documentSchema as {
          options?: Record<string, unknown>;
          optionSources?: Record<string, unknown>;
        };
        if (docSchema.options) {
          delete docSchema.options.contacts;
        }
        docSchema.optionSources = {
          contacts: { provider: 'document_log', properties: ['key', 'name'] },
          vendors: { provider: 'document_log', properties: ['key', 'name'] },
        };
        const logSchema = cloned.documentLogSchema as {
          optionBindings?: Record<string, unknown>;
        };
        logSchema.optionBindings = {
          contacts: {
            sheetName: '_Config',
            rangeName: 'Options_Contacts',
            endMarker: '---',
            columns: { Contact: 'key', Name: 'name' },
            aliasesColumn: 'Aliases',
          },
          vendors: {
            sheetName: '_Config',
            rangeName: 'Options_Vendors',
            endMarker: '---',
            columns: { Vendor: 'key', Name: 'name' },
            aliasesColumn: 'Aliases',
          },
        };
        return cloned;
      },
    };

    const logWiring = createDocumentLogWiring({
      manifestProvider: customManifestProvider,
      driveClient,
      sheetsClient,
      configProvider: manifestProvider,
      templateEvaluator: handlebars,
    });
    await logWiring.logSchemaRegistry.initialize();

    const docLogPort = logWiring.createDocumentLogService({});
    const res = await docLogPort.readOptionTables!({
      documentTypeKey: 'submittal-arch',
      space: {
        id: 'space-360',
        typeId: 'projects',
        name: 'Harborview',
        abstractStorageId: 'space-360',
      },
    });

    expect(res.status).toBe('ready');
    if (res.status === 'ready') {
      expect(res.tables.contacts).toEqual({
        status: 'ready',
        tuples: [
          {
            key: 'PMG',
            name: 'Pavarini McGovern',
            aliases: ['Pavarini, McGovern', 'ACME "Corp"', 'PCNE', '@pavarini.com'],
          },
          {
            key: 'INC',
            name: 'INC Architecture',
          },
        ],
      });
      expect(res.tables.vendors).toEqual({
        status: 'ready',
        tuples: [{ key: 'CARN', name: 'Carnegie Fabrics' }],
      });
    }
  });
});

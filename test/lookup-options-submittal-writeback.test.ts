import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceCard,
  GoogleWorkspaceSection,
  GoogleWorkspaceTextInput,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { createAnonymizedSubmittalCoverSheetPdf } from './fixtures/submittal-cover-sheet.fixture';

let cachedCoverSheetPdfBytes: Uint8Array | undefined;

const MANIFEST_PATH = path.resolve(__dirname, '../assets/manifest.json');
const DRIVE_ID = 'drive-361-e2e';
const SPACE_NAME = 'Civic Tower';
const TEMPLATE_SPREADSHEET_ID = '1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I';

type SimCellVal = string | number | boolean | null;

interface SimCell {
  value: SimCellVal;
  userEnteredFormat?: Record<string, unknown> | undefined;
}

interface SimNamedRange {
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

interface MultiSpreadsheetSim {
  spreadsheetId: string;
  sheets: Array<{ sheetId: number; title: string; grid: SimCell[][] }>;
  namedRanges: SimNamedRange[];
  batchUpdates: Array<{ requests: Array<Record<string, unknown>> }>;
}

function createAuthVerifier(): WorkspaceAuthVerifierPort {
  return {
    verifyToken: vi.fn().mockImplementation(async (header?: string) => {
      if (header?.startsWith('Bearer valid-')) {
        return { isValid: true, payload: { email: 'pm@inc.nyc', sub: 'user-361' } };
      }
      return { isValid: false, error: 'Unauthorized' };
    }),
  };
}

function getCard(payload: string, kind: 'pushCard' | 'updateCard'): GoogleWorkspaceCard {
  const body = JSON.parse(payload) as GoogleWorkspaceActionResponse;
  const nav = body.action?.navigations?.[0];
  const card = kind === 'pushCard' ? nav?.pushCard : nav?.updateCard;
  expect(card).toBeDefined();
  return card!;
}

function findSection(card: GoogleWorkspaceCard, header: string): GoogleWorkspaceSection | undefined {
  return card.sections.find((s) => s.header === header);
}

function findTextInput(
  section: GoogleWorkspaceSection | undefined,
  fieldKey: string,
  docTypeKey: string
): GoogleWorkspaceTextInput | undefined {
  const name = getDocumentInfoWidgetName(fieldKey, docTypeKey);
  return section?.widgets.find((w) => w.textInput?.name === name)?.textInput;
}

function colLettersToIdx(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

function parseSimA1Range(a1Range: string, defaultRows: number, defaultCols: number) {
  const bang = a1Range.lastIndexOf('!');
  const cellPart = (bang >= 0 ? a1Range.slice(bang + 1) : a1Range).trim();
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d*)$/i.exec(cellPart);
  if (!m) {
    return { startRowIndex: 0, endRowIndex: defaultRows, startColumnIndex: 0, endColumnIndex: defaultCols };
  }
  return {
    startRowIndex: Number(m[2]) - 1,
    endRowIndex: m[4] ? Number(m[4]) : defaultRows,
    startColumnIndex: colLettersToIdx(m[1].toUpperCase()),
    endColumnIndex: colLettersToIdx(m[3].toUpperCase()) + 1,
  };
}

function mountSpreadsheetNock(sim: MultiSpreadsheetSim, templateSim?: MultiSpreadsheetSim): void {
  const readRange = (target: MultiSpreadsheetSim, a1Range: string, renderOpt?: string): SimCellVal[][] => {
    const bang = a1Range.lastIndexOf('!');
    const rawSheet = bang >= 0 ? a1Range.slice(0, bang) : target.sheets[0].title;
    const sheetTitle = rawSheet.replace(/^'|'$/g, '').replace(/''/g, "'");
    const sheet = target.sheets.find((s) => s.title.toLowerCase() === sheetTitle.toLowerCase())!;
    const bounds = parseSimA1Range(
      a1Range,
      sheet.grid.length,
      Math.max(...sheet.grid.map((r) => r.length), 1)
    );
    return sheet.grid.slice(bounds.startRowIndex, bounds.endRowIndex).map((row) => {
      const out: SimCellVal[] = [];
      for (let c = bounds.startColumnIndex; c < bounds.endColumnIndex; c++) {
        const val = row[c]?.value ?? '';
        if (typeof val === 'string' && val.startsWith('=') && renderOpt !== 'FORMULA') {
          out.push('');
        } else {
          out.push(val);
        }
      }
      while (out.length > 0 && (out[out.length - 1] === '' || out[out.length - 1] === null)) {
        out.pop();
      }
      return out;
    });
  };

  const buildGetPayload = (target: MultiSpreadsheetSim, includeGridData: boolean) => ({
    spreadsheetId: target.spreadsheetId,
    sheets: target.sheets.map((s) => ({
      properties: { sheetId: s.sheetId, title: s.title },
      ...(includeGridData
        ? {
            data: [
              {
                startRow: 0,
                startColumn: 0,
                rowData: s.grid.map((row) => ({
                  values: row.map((cell) => ({
                    formattedValue: cell.value === null ? '' : String(cell.value),
                    ...(cell.userEnteredFormat ? { userEnteredFormat: structuredClone(cell.userEnteredFormat) } : {}),
                  })),
                })),
              },
            ],
          }
        : {}),
    })),
    namedRanges: target.namedRanges.map((nr) => ({
      namedRangeId: nr.namedRangeId,
      name: nr.name,
      range: { ...nr.range },
    })),
  });

  nock('https://sheets.googleapis.com')
    .persist()
    .get(`/v4/spreadsheets/${sim.spreadsheetId}`)
    .query(true)
    .reply(200, (uri) => {
      const url = new URL(uri, 'https://sheets.googleapis.com');
      return buildGetPayload(sim, url.searchParams.get('includeGridData') === 'true');
    });

  if (templateSim) {
    nock('https://sheets.googleapis.com')
      .get(`/v4/spreadsheets/${templateSim.spreadsheetId}`)
      .query(true)
      .reply(200, (uri) => {
        const url = new URL(uri, 'https://sheets.googleapis.com');
        return buildGetPayload(templateSim, url.searchParams.get('includeGridData') === 'true');
      });
  }

  nock('https://sheets.googleapis.com')
    .persist()
    .get(`/v4/spreadsheets/${sim.spreadsheetId}/values:batchGet`)
    .query(true)
    .reply(200, (uri) => {
      const url = new URL(uri, 'https://sheets.googleapis.com');
      const ranges = url.searchParams.getAll('ranges');
      const renderOpt = url.searchParams.get('valueRenderOption') ?? 'FORMATTED_VALUE';
      return {
        spreadsheetId: sim.spreadsheetId,
        valueRanges: ranges.map((range) => ({
          range,
          values: readRange(sim, range, renderOpt),
        })),
      };
    });

  nock('https://sheets.googleapis.com')
    .persist()
    .get(new RegExp(`/v4/spreadsheets/${sim.spreadsheetId}/values/.*`))
    .query(true)
    .reply(200, (uri) => {
      const url = new URL(uri, 'https://sheets.googleapis.com');
      const prefix = `/v4/spreadsheets/${sim.spreadsheetId}/values/`;
      const rawA1 = decodeURIComponent(url.pathname.slice(prefix.length));
      const renderOpt = url.searchParams.get('valueRenderOption') ?? 'FORMATTED_VALUE';
      return {
        range: rawA1,
        values: readRange(sim, rawA1, renderOpt),
      };
    });

  nock('https://sheets.googleapis.com')
    .persist()
    .post(`/v4/spreadsheets/${sim.spreadsheetId}:batchUpdate`)
    .reply(200, (_uri, body) => {
      const requests = (body as { requests: Array<Record<string, unknown>> }).requests;
      sim.batchUpdates.push({ requests });

      for (const req of requests) {
        const insDim = req.insertDimension as
          | { range?: { sheetId?: number; startIndex?: number; endIndex?: number } }
          | undefined;
        if (insDim?.range) {
          const { sheetId, startIndex = 0, endIndex = 0 } = insDim.range;
          const sheet = sim.sheets.find((s) => s.sheetId === sheetId)!;
          const count = endIndex - startIndex;
          for (let i = 0; i < count; i++) sheet.grid.splice(startIndex, 0, []);
          for (const nr of sim.namedRanges) {
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
          const sheet = sim.sheets.find((s) => s.sheetId === sheetId)!;
          const count = endRowIndex - startRowIndex;
          const prevLen = sheet.grid.length;
          for (let i = 0; i < count; i++) sheet.grid.push([]);
          for (let r = prevLen - 1; r >= startRowIndex; r--) {
            for (let c = startColumnIndex; c < endColumnIndex; c++) {
              while (sheet.grid[r + count]!.length <= c) sheet.grid[r + count]!.push({ value: '' });
              sheet.grid[r + count]![c] = { ...(sheet.grid[r]?.[c] ?? { value: '' }) };
            }
          }
          for (let r = startRowIndex; r < endRowIndex; r++) {
            for (let c = startColumnIndex; c < endColumnIndex; c++) {
              while (sheet.grid[r]!.length <= c) sheet.grid[r]!.push({ value: '' });
              sheet.grid[r]![c] = { value: '' };
            }
          }
          for (const nr of sim.namedRanges) {
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
              rows?: Array<{
                values?: Array<{
                  userEnteredValue?: { stringValue?: string; formulaValue?: string };
                  userEnteredFormat?: Record<string, unknown>;
                }>;
              }>;
              fields?: string;
            }
          | undefined;
        if (updCells?.range && updCells.rows) {
          const sheet = sim.sheets.find((s) => s.sheetId === updCells.range!.sheetId)!;
          const sr = updCells.range.startRowIndex ?? 0;
          const sc = updCells.range.startColumnIndex ?? 0;
          const fields = new Set((updCells.fields ?? '').split(',').map((f) => f.trim()));
          updCells.rows.forEach((row, rOff) => {
            while (sheet.grid.length <= sr + rOff) sheet.grid.push([]);
            const targetRow = sheet.grid[sr + rOff]!;
            (row.values ?? []).forEach((cell, cOff) => {
              while (targetRow.length <= sc + cOff) targetRow.push({ value: '' });
              const cur = { ...targetRow[sc + cOff]! };
              if (fields.has('userEnteredValue')) {
                if (cell.userEnteredValue?.stringValue !== undefined) {
                  cur.value = cell.userEnteredValue.stringValue;
                } else if (cell.userEnteredValue?.formulaValue !== undefined) {
                  cur.value = cell.userEnteredValue.formulaValue;
                } else {
                  cur.value = '';
                }
              }
              if (fields.has('userEnteredFormat')) {
                cur.userEnteredFormat = cell.userEnteredFormat ? structuredClone(cell.userEnteredFormat) : undefined;
              }
              targetRow[sc + cOff] = cur;
            });
          });
        }
        const updNr = req.updateNamedRange as
          | { namedRange?: { namedRangeId?: string; range?: { startRowIndex?: number; endRowIndex?: number } } }
          | undefined;
        if (updNr?.namedRange?.namedRangeId && updNr.namedRange.range) {
          const existing = sim.namedRanges.find((nr) => nr.namedRangeId === updNr.namedRange!.namedRangeId);
          if (existing) {
            existing.range.startRowIndex = updNr.namedRange.range.startRowIndex ?? existing.range.startRowIndex;
            existing.range.endRowIndex = updNr.namedRange.range.endRowIndex ?? existing.range.endRowIndex;
          }
        }
      }
      return {};
    });
}

function createFullMultiSim(spreadsheetId: string): MultiSpreadsheetSim {
  const c = (value: SimCellVal): SimCell => ({ value });
  return {
    spreadsheetId,
    sheets: [
      {
        sheetId: 101,
        title: 'Submittal Arch',
        grid: [
          [],
          [],
          ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'].map(c),
          ['Formula Row'].map(c),
          [c('<--->')],
          [c('')],
          [c('<--->')],
        ],
      },
      {
        sheetId: 102,
        title: 'Submittal FF&E',
        grid: [
          [],
          [],
          ['Status', 'Spec Tag', 'Related Tag', 'Revision', 'Spec Title', 'Vendor', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'].map(c),
          [c('Formula Row'), c(''), c(''), c(''), c('=ARRAYFORMULA(IF(B6:B="","",VLOOKUP(B6:B,Options_Submittal_FFE_Specs,2,FALSE)))')],
          [c('<--->')],
          [c('')],
          [c('<--->')],
        ],
      },
      {
        sheetId: 103,
        title: '_Config Submittal Arch',
        grid: [
          ['Status', '', 'Action', 'Name', 'Suffix', 'Order', '', 'Contact', 'Name', 'Contact Type', '', 'Division Number', 'Division Folder'].map(c),
          ['Open', '', 'REC', 'Received', '', '1', '', 'INC', 'INC Architecture and Design', 'INC', '', '01', '01 General Requirements'].map(c),
          ['Closed', '', 'NOC', 'No Objections As Corrected', '_NOC', '6', '', '---', '', '', '', '03', '03 Concrete'].map(c),
          ['---', '', '---', '', '', '', '', '', '', '', '', '07', '07 Thermal and Moisture Protection'].map(c),
          ['', '', '', '', '', '', '', '', '', '', '', '08', '08 Openings'].map(c),
          ['', '', '', '', '', '', '', '', '', '', '', '09', '09 Finishes'].map(c),
          ['', '', '', '', '', '', '', '', '', '', '', '---', ''].map(c),
        ],
      },
      {
        sheetId: 104,
        title: '_Config Submittal FF&E',
        grid: [
          ['Status', '', 'Action', 'Name', 'Suffix', 'Order', '', 'Contact', 'Name', 'Contact Type', '', 'Vendor', 'Name', 'Vendor Type', '', 'Spec Tag', 'Spec Title'].map(c),
          ['Open', '', 'REC', 'Received', '', '1', '', 'INC', 'INC Architecture & Design', 'INC', '', 'BM', 'Berman Falk', 'Casegoods', '', 'AC102', 'HOOK'].map(c),
          ['Closed', '', 'NOC', 'No Objections As Corrected', '_NOC', '6', '', 'PARTIAL', '', '', '', '---', '', '', '', 'CG104', 'BED - KING'].map(c),
          ['---', '', '---', '', '', '', '', '---', '', '', '', '', '', '', '', 'FB127', 'FABRIC - LEATHER'].map(c),
          ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '---', ''].map(c),
        ],
      },
    ],
    namedRanges: [
      {
        namedRangeId: 'nr-log-arch',
        name: 'Log_Submittal_Arch',
        range: { sheetId: 101, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 10 },
      },
      {
        namedRangeId: 'nr-log-ffe',
        name: 'Log_Submittal_FFE',
        range: { sheetId: 102, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 11 },
      },
      {
        namedRangeId: 'nr-arch-statuses',
        name: 'Options_Submittal_Arch_Statuses',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-arch-val-statuses',
        name: 'Validation_Submittal_Arch_Statuses',
        range: { sheetId: 103, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-arch-actions',
        name: 'Options_Submittal_Arch_Actions',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 2, endColumnIndex: 6 },
      },
      {
        namedRangeId: 'nr-arch-contacts',
        name: 'Options_Submittal_Arch_Contacts',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 10 },
      },
      {
        namedRangeId: 'nr-arch-val-contacts',
        name: 'Validation_Submittal_Arch_Contacts',
        range: { sheetId: 103, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 7, endColumnIndex: 8 },
      },
      {
        namedRangeId: 'nr-arch-csi-divisions',
        name: 'Options_Submittal_Arch_CSI_Divisions',
        range: { sheetId: 103, startRowIndex: 0, endRowIndex: 7, startColumnIndex: 11, endColumnIndex: 13 },
      },
      {
        namedRangeId: 'nr-ffe-statuses',
        name: 'Options_Submittal_FFE_Statuses',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-ffe-val-statuses',
        name: 'Validation_Submittal_FFE_Statuses',
        range: { sheetId: 104, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-ffe-actions',
        name: 'Options_Submittal_FFE_Actions',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 2, endColumnIndex: 6 },
      },
      {
        namedRangeId: 'nr-ffe-contacts',
        name: 'Options_Submittal_FFE_Contacts',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: 4, startColumnIndex: 7, endColumnIndex: 10 },
      },
      {
        namedRangeId: 'nr-ffe-val-contacts',
        name: 'Validation_Submittal_FFE_Contacts',
        range: { sheetId: 104, startRowIndex: 1, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 8 },
      },
      {
        namedRangeId: 'nr-ffe-vendors',
        name: 'Options_Submittal_FFE_Vendors',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 11, endColumnIndex: 14 },
      },
      {
        namedRangeId: 'nr-ffe-val-vendors',
        name: 'Validation_Submittal_FFE_Vendors',
        range: { sheetId: 104, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 11, endColumnIndex: 12 },
      },
      {
        namedRangeId: 'nr-ffe-specs',
        name: 'Options_Submittal_FFE_Specs',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: 5, startColumnIndex: 15, endColumnIndex: 17 },
      },
      {
        namedRangeId: 'nr-ffe-val-specs',
        name: 'Validation_Submittal_FFE_Specs',
        range: { sheetId: 104, startRowIndex: 1, endRowIndex: 4, startColumnIndex: 15, endColumnIndex: 16 },
      },
    ],
    batchUpdates: [],
  };
}

function mockDriveForSubmittalSubmit(logId: string, baseFolderName: string, subFolderName: string, fileId: string, newName: string) {
  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/drives')
    .query(true)
    .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'"))
    .reply(200, {
      files: [
        {
          id: logId,
          name: `${SPACE_NAME} Document Log`,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          parents: [DRIVE_ID],
          webViewLink: `https://docs.google.com/spreadsheets/d/${logId}/edit`,
        },
      ],
    });

  nock('https://www.googleapis.com')
    .persist()
    .get(`/drive/v3/files/${fileId}`)
    .query(true)
    .reply(200, { id: fileId, name: 'Upload.pdf', mimeType: 'application/pdf', parents: ['inbox'] });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes(`name = '${baseFolderName}'`))
    .reply(200, {
      files: [{ id: 'base-folder-id', name: baseFolderName, parents: [DRIVE_ID], mimeType: 'application/vnd.google-apps.folder' }],
    });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes(`name = '${subFolderName}'`))
    .reply(200, {
      files: [{ id: 'sub-folder-id', name: subFolderName, parents: ['base-folder-id'], mimeType: 'application/vnd.google-apps.folder' }],
    });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("mimeType = 'application/vnd.google-apps.folder'") &&
        !q.q.includes(`name = '${baseFolderName}'`) &&
        !q.q.includes(`name = '${subFolderName}'`)
    )
    .reply(200, { files: [] });

  nock('https://www.googleapis.com')
    .persist()
    .post('/drive/v3/files')
    .query(true)
    .reply(200, (_uri, body) => {
      const reqBody = body as { name?: string; parents?: string[] };
      return {
        id: `folder-${reqBody.name ?? 'dyn'}`,
        name: reqBody.name ?? 'dyn',
        parents: reqBody.parents ?? ['sub-folder-id'],
        mimeType: 'application/vnd.google-apps.folder',
      };
    });

  nock('https://www.googleapis.com')
    .persist()
    .patch(`/drive/v3/files/${fileId}`)
    .query(true)
    .reply(200, {
      id: fileId,
      name: newName,
      parents: ['sub-folder-id'],
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    });

  nock('https://www.googleapis.com')
    .persist()
    .post(`/drive/v3/files/${fileId}/copy`)
    .query(true)
    .reply(200, (_uri, body) => {
      const reqBody = body as { name?: string; parents?: string[] };
      return {
        id: `${fileId}-copy`,
        name: reqBody.name ?? `_${newName}`,
        parents: reqBody.parents ?? ['sub-folder-id'],
        mimeType: 'application/pdf',
        webViewLink: `https://drive.google.com/file/d/${fileId}-copy/view`,
      };
    });

  const pdfBytes = cachedCoverSheetPdfBytes;
  if (!pdfBytes) {
    throw new Error('cachedCoverSheetPdfBytes must be initialized in beforeEach');
  }

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files/test-cover-sheet-tpl')
    .query((q) => q.alt !== 'media')
    .reply(200, {
      id: 'test-cover-sheet-tpl',
      name: 'Cover Sheet.pdf',
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
    });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files/test-cover-sheet-tpl')
    .query((q) => q.alt === 'media')
    .reply(200, Buffer.from(pdfBytes));

  nock('https://www.googleapis.com')
    .persist()
    .get(`/drive/v3/files/${fileId}-copy`)
    .query((q) => q.alt !== 'media')
    .reply(200, {
      id: `${fileId}-copy`,
      name: `_${newName}`,
      mimeType: 'application/pdf',
      size: pdfBytes.byteLength,
      parents: ['sub-folder-id'],
    });

  nock('https://www.googleapis.com')
    .persist()
    .get(`/drive/v3/files/${fileId}-copy`)
    .query((q) => q.alt === 'media')
    .reply(200, Buffer.from(pdfBytes));

  nock('https://www.googleapis.com')
    .persist()
    .patch(`/upload/drive/v3/files/${fileId}-copy`)
    .query(true)
    .reply(200, {
      id: `${fileId}-copy`,
      name: `_${newName}`,
      mimeType: 'application/pdf',
      parents: ['sub-folder-id'],
      webViewLink: `https://drive.google.com/file/d/${fileId}-copy/view`,
    });
}

describe('Ticket #361 Workspace Addon & App E2E: Submittal Arch contacts & Submittal FF&E atomic _Config write-back', () => {
  let app: AppInstance;

  beforeEach(async () => {
    vi.stubEnv('SUBMITTAL_COVER_SHEET_TEMPLATE_ID', 'test-cover-sheet-tpl');
    cachedCoverSheetPdfBytes ??= await createAnonymizedSubmittalCoverSheetPdf();
    app = createApp({
      manifestProvider: new AppManifestProvider({ manifestPath: MANIFEST_PATH }),
      authVerifier: createAuthVerifier(),
      skipSpaceValidation: true,
    });
    await app.initialize();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('loads Submittal Arch contacts from _Config and atomically inserts custom Contact above "---", extends Validation_*, and writes Log_Submittal_Arch in 1 batchUpdate', async () => {
    const logId = 'log-arch-361';
    const sim = createFullMultiSim(logId);
    mountSpreadsheetNock(sim);
    mockDriveForSubmittalSubmit(
      logId,
      '6 Construction',
      'Submittals',
      'file-arch-361',
      '071200-001-0 Waterproofing - 260204 Acme Studio.pdf'
    );

    const openRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [
            { id: 'file-arch-361', title: '071200-001-0_Waterproofing.pdf', mimeType: 'application/pdf' },
          ],
        },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-arch-361'] } },
          },
        },
      },
    });
    expect(openRes.statusCode).toBe(200);
    const openCard = getCard(openRes.payload, 'updateCard');
    const dataSec = findSection(openCard, 'Document Data');
    const contactInput = findTextInput(dataSec, 'contact', 'submittal-arch');
    expect(contactInput?.initialSuggestions?.items).toEqual([
      { text: 'INC Architecture and Design' },
    ]);

    const submitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [
            { id: 'file-arch-361', title: '071200-001-0_Waterproofing.pdf', mimeType: 'application/pdf' },
          ],
        },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-arch-361'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['Acme Studio'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });

    expect(submitRes.statusCode).toBe(200);
    const submitBody = JSON.parse(submitRes.payload);
    expect(submitBody.action?.notification).toBeUndefined();
    expect(submitBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe(
      'Submittal Arch Filed'
    );
    expect(sim.batchUpdates).toHaveLength(1);

    const configGrid = sim.sheets[2].grid;
    const contactsNr = sim.namedRanges.find((nr) => nr.name === 'Options_Submittal_Arch_Contacts')!;
    expect(
      configGrid
        .slice(contactsNr.range.startRowIndex, contactsNr.range.endRowIndex)
        .map((r) => r.slice(7, 10).map((cell) => cell.value))
    ).toEqual([
      ['Contact', 'Name', 'Contact Type'],
      ['INC', 'INC Architecture and Design', 'INC'],
      ['Acme Studio', 'Acme Studio', ''],
      ['---', '', ''],
    ]);
    // Neighboring Statuses & Actions did not shift
    expect(configGrid[3][0].value).toBe('---');
    expect(configGrid[3][2].value).toBe('---');
    // Companion Validation_Submittal_Arch_Contacts extended from 1..2 to 1..3
    expect(sim.namedRanges.find((nr) => nr.name === 'Validation_Submittal_Arch_Contacts')?.range).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 3,
    });
    // Log_Submittal_Arch written in same atomic batchUpdate
    expect(sim.sheets[0].grid[5].slice(0, 7).map((c) => c.value)).toEqual([
      'Open',
      '071200',
      '001',
      '0',
      'Waterproofing',
      '260204',
      'Acme Studio',
    ]);
  });

  it('loads Submittal FF&E base tables from _Config, preserves blank Name when existing Contact key is selected, and inserts new custom Vendor in 1 atomic batchUpdate', async () => {
    const logId = 'log-ffe-361';
    const sim = createFullMultiSim(logId);
    mountSpreadsheetNock(sim);
    mockDriveForSubmittalSubmit(
      logId,
      '3 FFE',
      '05 Submittals',
      'file-ffe-361',
      'AC102-0 Zenith Custom - 260204 PARTIAL.pdf'
    );

    const submitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [
            { id: 'file-ffe-361', title: 'AC102-0_Upload.pdf', mimeType: 'application/pdf' },
          ],
        },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            SelectFiles: { stringInputs: { value: ['file-ffe-361'] } },
            [getDocumentInfoWidgetName('status', 'submittal-ffe')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: ['AC102'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-ffe')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('specTitle', 'submittal-ffe')]: { stringInputs: { value: ['HOOK'] } },
            [getDocumentInfoWidgetName('vendor', 'submittal-ffe')]: { stringInputs: { value: ['Zenith Custom'] } },
            [getDocumentInfoWidgetName('date', 'submittal-ffe')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-ffe')]: { stringInputs: { value: ['PARTIAL'] } },
            [getDocumentInfoWidgetName('action', 'submittal-ffe')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });

    expect(submitRes.statusCode).toBe(200);
    const submitBody = JSON.parse(submitRes.payload);
    expect(submitBody.action?.notification).toBeUndefined();
    expect(submitBody.action?.navigations?.[0]?.pushCard?.header?.title).toBe(
      'Submittal FF&E Filed'
    );
    expect(sim.batchUpdates).toHaveLength(1);

    const ffeConfig = sim.sheets[3].grid;
    const ffeContactsNr = sim.namedRanges.find((nr) => nr.name === 'Options_Submittal_FFE_Contacts')!;
    const ffeVendorsNr = sim.namedRanges.find((nr) => nr.name === 'Options_Submittal_FFE_Vendors')!;
    // Contacts: PARTIAL row preserves blank Name (no backfill when key selected), no extra row inserted, Contact Type still blank
    expect(
      ffeConfig
        .slice(ffeContactsNr.range.startRowIndex, ffeContactsNr.range.endRowIndex)
        .map((r) => r.slice(7, 10).map((cell) => cell.value))
    ).toEqual([
      ['Contact', 'Name', 'Contact Type'],
      ['INC', 'INC Architecture & Design', 'INC'],
      ['PARTIAL', '', ''],
      ['---', '', ''],
    ]);
    // Vendors: Zenith Custom inserted above '---', Vendor Type left blank
    expect(
      ffeConfig
        .slice(ffeVendorsNr.range.startRowIndex, ffeVendorsNr.range.endRowIndex)
        .map((r) => r.slice(11, 14).map((cell) => cell.value))
    ).toEqual([
      ['Vendor', 'Name', 'Vendor Type'],
      ['BM', 'Berman Falk', 'Casegoods'],
      ['Zenith Custom', 'Zenith Custom', ''],
      ['---', '', ''],
    ]);
    expect(sim.namedRanges.find((nr) => nr.name === 'Validation_Submittal_FFE_Contacts')?.range).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 3,
    });
    expect(sim.namedRanges.find((nr) => nr.name === 'Validation_Submittal_FFE_Vendors')?.range).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 3,
    });
  });

  it('copies data-row cell formatting from configuration.documentLog.templateSpreadsheetId when inserting into an empty option table via Workspace Addon', async () => {
    const logId = 'log-empty-361';
    const sim = createFullMultiSim(logId);
    // Make Options_Submittal_Arch_Contacts empty (Header + '---' only)
    const archCfg = sim.sheets[2].grid;
    archCfg[1][7] = { value: '---' };
    archCfg[1][8] = { value: '' };
    archCfg[1][9] = { value: '' };
    archCfg[2][7] = { value: '' };
    sim.namedRanges.find((nr) => nr.name === 'Options_Submittal_Arch_Contacts')!.range.endRowIndex = 2;
    sim.namedRanges.find((nr) => nr.name === 'Validation_Submittal_Arch_Contacts')!.range = {
      sheetId: 103,
      startRowIndex: 1,
      endRowIndex: 2,
      startColumnIndex: 7,
      endColumnIndex: 8,
    };

    const tmplFormat = { textFormat: { fontFamily: 'Inter', fontSize: 9 }, backgroundColor: { red: 1, green: 1, blue: 1 } };
    const templateSim: MultiSpreadsheetSim = {
      spreadsheetId: TEMPLATE_SPREADSHEET_ID,
      sheets: [
        {
          sheetId: 903,
          title: '_Config Submittal Arch',
          grid: [
            [{ value: 'Contact' }, { value: 'Name' }, { value: 'Contact Type' }],
            [
              { value: 'INC', userEnteredFormat: tmplFormat },
              { value: 'INC Architecture and Design', userEnteredFormat: tmplFormat },
              { value: 'INC', userEnteredFormat: tmplFormat },
            ],
            [{ value: '---' }, { value: '' }, { value: '' }],
          ],
        },
      ],
      namedRanges: [
        {
          namedRangeId: 'tmpl-contacts',
          name: 'Options_Submittal_Arch_Contacts',
          range: { sheetId: 903, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 0, endColumnIndex: 3 },
        },
      ],
      batchUpdates: [],
    };

    mountSpreadsheetNock(sim, templateSim);
    mockDriveForSubmittalSubmit(
      logId,
      '6 Construction',
      'Submittals',
      'file-empty-361',
      '071200-001-0 Waterproofing - 260204 FirstContact.pdf'
    );

    const submitRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [
            { id: 'file-empty-361', title: '071200-001-0_Upload.pdf', mimeType: 'application/pdf' },
          ],
        },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-empty-361'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['FirstContact'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });

    expect(submitRes.statusCode).toBe(200);
    expect(sim.batchUpdates).toHaveLength(1);
    expect(sim.sheets[2].grid[1][7]).toEqual({ value: 'FirstContact', userEnteredFormat: tmplFormat });
    expect(sim.sheets[2].grid[1][8]).toEqual({ value: 'FirstContact', userEnteredFormat: tmplFormat });
    expect(sim.sheets[2].grid[1][9]).toEqual({ value: '', userEnteredFormat: tmplFormat });
  });

  it('fails fast with config_error before MOVE_FILE or log mutation when target _Config table lacks "---" across Workspace Addon and POST /documents', async () => {
    const brokenLogId = 'log-broken-361';
    const brokenSim = createFullMultiSim(brokenLogId);
    // Remove '---' from Options_Submittal_Arch_Contacts
    brokenSim.sheets[2].grid[2][7] = { value: '' };
    mountSpreadsheetNock(brokenSim);
    nock('https://www.googleapis.com')
      .persist()
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    nock('https://www.googleapis.com')
      .persist()
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'"))
      .reply(200, {
        files: [{ id: brokenLogId, name: `${SPACE_NAME} Document Log`, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [DRIVE_ID] }],
      });

    const failPostRes = await app.server.inject({
      method: 'POST',
      url: '/documents?eventName=onSubmit',
      payload: {
        type: 'submittal-arch',
        space: { id: DRIVE_ID, typeId: 'projects', name: SPACE_NAME, abstractStorageId: DRIVE_ID },
        data: {
          status: 'Open',
          section: '071200',
          number: '001',
          revision: '0',
          title: 'Waterproofing',
          date: '260204',
          contact: 'NewContact',
          action: 'REC',
        },
      },
    });
    expect(failPostRes.statusCode).toBe(400);
    expect(JSON.stringify(JSON.parse(failPostRes.payload))).toMatch(/Option table.*error|---/i);
    expect(brokenSim.batchUpdates).toHaveLength(0);

    const failAddonRes = await app.server.inject({
      method: 'POST',
      url: '/workspace/action',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [{ id: 'file-broken-361', title: '071200-001-0.pdf', mimeType: 'application/pdf' }],
        },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'processDocument' },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
            SelectFiles: { stringInputs: { value: ['file-broken-361'] } },
            [getDocumentInfoWidgetName('status', 'submittal-arch')]: { stringInputs: { value: ['Open'] } },
            [getDocumentInfoWidgetName('section', 'submittal-arch')]: { stringInputs: { value: ['071200'] } },
            [getDocumentInfoWidgetName('number', 'submittal-arch')]: { stringInputs: { value: ['001'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-arch')]: { stringInputs: { value: ['0'] } },
            [getDocumentInfoWidgetName('title', 'submittal-arch')]: { stringInputs: { value: ['Waterproofing'] } },
            [getDocumentInfoWidgetName('date', 'submittal-arch')]: { stringInputs: { value: ['260204'] } },
            [getDocumentInfoWidgetName('contact', 'submittal-arch')]: { stringInputs: { value: ['NewContact'] } },
            [getDocumentInfoWidgetName('action', 'submittal-arch')]: { stringInputs: { value: ['REC'] } },
          },
        },
      },
    });
    expect(failAddonRes.statusCode).toBe(200);
    expect(brokenSim.batchUpdates).toHaveLength(0);
  });
});

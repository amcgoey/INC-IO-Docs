import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import nock from 'nock';
import { createApp, type AppInstance } from '../src/app/server';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import type {
  GoogleWorkspaceActionResponse,
  GoogleWorkspaceCard,
  GoogleWorkspaceDecoratedText,
  GoogleWorkspaceSection,
  GoogleWorkspaceTextInput,
} from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentSpaceWidgetName,
  getDocumentTypeWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import { SELECT_DOCUMENT_LOG_KEY } from '../src/features/schema-driven-ui/blocks/document-log';

const MANIFEST_PATH = path.resolve(__dirname, '../assets/manifest.json');
const DRIVE_ID = 'drive-362-e2e';
const SPACE_NAME = 'Harborview FF&E';

type SimCellVal = string | number | boolean | null;

interface SimCell {
  value: SimCellVal;
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
        return { isValid: true, payload: { email: 'ffe@inc.nyc', sub: 'user-362' } };
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

function findDecoratedText(
  section: GoogleWorkspaceSection | undefined,
  topLabel: string
): GoogleWorkspaceDecoratedText | undefined {
  return section?.widgets.find((w) => w.decoratedText?.topLabel === topLabel)?.decoratedText;
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

function mountSpreadsheetNock(sim: MultiSpreadsheetSim): void {
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

  nock('https://sheets.googleapis.com')
    .persist()
    .get(`/v4/spreadsheets/${sim.spreadsheetId}`)
    .query(true)
    .reply(200, () => ({
      spreadsheetId: sim.spreadsheetId,
      sheets: sim.sheets.map((s) => ({
        properties: { sheetId: s.sheetId, title: s.title },
      })),
      namedRanges: sim.namedRanges.map((nr) => ({
        namedRangeId: nr.namedRangeId,
        name: nr.name,
        range: { ...nr.range },
      })),
    }));

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

function createFfeSim(
  spreadsheetId: string,
  specsRows: SimCellVal[][] = [
    ['Spec Tag', 'Spec Title'],
    ['AC102', 'HOOK'],
    ['FB127', 'FABRIC - LEATHER'],
    ['FB135', 'FABRIC - LEATHER'],
    ['BLANK1', ''],
    ['---', ''],
  ]
): MultiSpreadsheetSim {
  const c = (value: SimCellVal): SimCell => ({ value });
  const cfgStatuses = [['Status'], ['Open'], ['Closed'], ['---']];
  const cfgActions = [
    ['Action', 'Name', 'Suffix', 'Order'],
    ['REC', 'Received', '', '1'],
    ['NOC', 'No Objections As Corrected', '_NOC', '6'],
    ['---', '', '', ''],
  ];
  const cfgContacts = [
    ['Contact', 'Name', 'Contact Type'],
    ['INC', 'INC Architecture & Design', 'INC'],
    ['---', '', ''],
  ];
  const cfgVendors = [
    ['Vendor', 'Name', 'Vendor Type'],
    ['BM', 'Berman Falk', 'Casegoods'],
    ['---', '', ''],
  ];

  const maxRows = Math.max(
    cfgStatuses.length,
    cfgActions.length,
    cfgContacts.length,
    cfgVendors.length,
    specsRows.length
  );
  const configGrid: SimCell[][] = Array.from({ length: maxRows }, (_, r) => {
    const row: SimCell[] = Array.from({ length: 17 }, () => c(''));
    const st = cfgStatuses[r];
    if (st) row[0] = c(st[0]);
    const act = cfgActions[r];
    if (act) act.forEach((v, idx) => (row[2 + idx] = c(v)));
    const con = cfgContacts[r];
    if (con) con.forEach((v, idx) => (row[7 + idx] = c(v)));
    const ven = cfgVendors[r];
    if (ven) ven.forEach((v, idx) => (row[11 + idx] = c(v)));
    const sp = specsRows[r];
    if (sp) sp.forEach((v, idx) => (row[15 + idx] = c(v)));
    return row;
  });

  return {
    spreadsheetId,
    sheets: [
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
        sheetId: 104,
        title: '_Config Submittal FF&E',
        grid: configGrid,
      },
    ],
    namedRanges: [
      {
        namedRangeId: 'nr-log-ffe',
        name: 'Log_Submittal_FFE',
        range: { sheetId: 102, startRowIndex: 2, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 11 },
      },
      {
        namedRangeId: 'nr-ffe-statuses',
        name: 'Options_Submittal_FFE_Statuses',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: cfgStatuses.length, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-ffe-actions',
        name: 'Options_Submittal_FFE_Actions',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: cfgActions.length, startColumnIndex: 2, endColumnIndex: 6 },
      },
      {
        namedRangeId: 'nr-ffe-contacts',
        name: 'Options_Submittal_FFE_Contacts',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: cfgContacts.length, startColumnIndex: 7, endColumnIndex: 10 },
      },
      {
        namedRangeId: 'nr-ffe-vendors',
        name: 'Options_Submittal_FFE_Vendors',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: cfgVendors.length, startColumnIndex: 11, endColumnIndex: 14 },
      },
      {
        namedRangeId: 'nr-ffe-specs',
        name: 'Options_Submittal_FFE_Specs',
        range: { sheetId: 104, startRowIndex: 0, endRowIndex: specsRows.length, startColumnIndex: 15, endColumnIndex: 17 },
      },
      {
        namedRangeId: 'nr-ffe-val-specs',
        name: 'Validation_Submittal_FFE_Specs',
        range: { sheetId: 104, startRowIndex: 1, endRowIndex: specsRows.length - 1, startColumnIndex: 15, endColumnIndex: 16 },
      },
    ],
    batchUpdates: [],
  };
}

function mockDriveForFfe(logs: Array<{ id: string; name: string; modifiedTime?: string }>, fileId = 'file-ffe-362') {
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
      files: logs.map((l) => ({
        id: l.id,
        name: l.name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
        parents: [DRIVE_ID],
        modifiedTime: l.modifiedTime ?? '2026-11-20T12:00:00Z',
        webViewLink: `https://docs.google.com/spreadsheets/d/${l.id}/edit`,
      })),
    });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("name = '1 Admin'") &&
        q.q.includes("mimeType = 'application/vnd.google-apps.folder'")
    )
    .reply(200, {
      files: [{ id: 'admin-folder-id', name: '1 Admin', parents: [DRIVE_ID] }],
    });

  nock('https://www.googleapis.com')
    .persist()
    .get(`/drive/v3/files/${fileId}`)
    .query(true)
    .reply(200, { id: fileId, name: 'Upload.pdf', mimeType: 'application/pdf', parents: ['inbox'] });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes("name = '3 FFE'"))
    .reply(200, {
      files: [{ id: 'ffe-folder-id', name: '3 FFE', parents: [DRIVE_ID], mimeType: 'application/vnd.google-apps.folder' }],
    });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes("name = '05 Submittals'"))
    .reply(200, {
      files: [{ id: 'ffe-sub-id', name: '05 Submittals', parents: ['ffe-folder-id'], mimeType: 'application/vnd.google-apps.folder' }],
    });

  nock('https://www.googleapis.com')
    .persist()
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("mimeType = 'application/vnd.google-apps.folder'") &&
        !q.q.includes("name = '1 Admin'") &&
        !q.q.includes("name = '3 FFE'") &&
        !q.q.includes("name = '05 Submittals'")
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
        parents: reqBody.parents ?? ['ffe-sub-id'],
        mimeType: 'application/vnd.google-apps.folder',
      };
    });

  nock('https://www.googleapis.com')
    .persist()
    .patch(`/drive/v3/files/${fileId}`)
    .query(true)
    .reply(200, {
      id: fileId,
      name: 'Filed_Submittal.pdf',
      parents: ['ffe-sub-id'],
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    });
}

describe('Ticket #362 E2E (Workspace Addon + POST /documents): Reactive LinkedField Locking & Submittal FF&E specs Cutover', () => {
  let app: AppInstance;

  beforeEach(async () => {
    app = createApp({
      manifestProvider: new AppManifestProvider({ manifestPath: MANIFEST_PATH }),
      authVerifier: createAuthVerifier(),
      skipSpaceValidation: true,
      lookupTimeoutMs: 120,
    });
    await app.initialize();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    vi.restoreAllMocks();
  });

  it('shows canonical spec tag keys in autocomplete, locks Spec Title as decoratedText only on key match with non-blank title, and unlocks on custom/blank/blank-property/missing_log/error', async () => {
    const logId = 'log-ffe-362-lock';
    const sim = createFfeSim(logId);
    mountSpreadsheetNock(sim);
    mockDriveForFfe([{ id: logId, name: `${SPACE_NAME} Document Log` }]);

    const callOnChange = async (specTagValue: string) =>
      app.server.inject({
        method: 'POST',
        url: '/workspace/on-form-change',
        headers: { authorization: 'Bearer valid-jwt' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.token' },
          drive: {
            selectedItems: [{ id: 'file-ffe-362', title: 'Upload.pdf', mimeType: 'application/pdf' }],
          },
          commonEventObject: {
            hostApp: 'DRIVE',
            parameters: { action: 'onFormChange' },
            formInputs: {
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
              SelectFiles: { stringInputs: { value: ['file-ffe-362'] } },
              [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: [specTagValue] } },
            },
          },
        },
      });

    // 1. Known key 'ac102' -> autocomplete shows canonical keys (including FB127 & FB135 sharing title), Spec Title locked as decoratedText
    const knownRes = await callOnChange('ac102');
    expect(knownRes.statusCode).toBe(200);
    const knownCard = getCard(knownRes.payload, 'updateCard');
    const knownSec = findSection(knownCard, 'Document Data');
    expect(findTextInput(knownSec, 'specTag', 'submittal-ffe')?.initialSuggestions?.items).toEqual([
      { text: 'AC102' },
      { text: 'FB127' },
      { text: 'FB135' },
      { text: 'BLANK1' },
    ]);
    expect(findTextInput(knownSec, 'relatedTag', 'submittal-ffe')?.initialSuggestions?.items).toEqual([
      { text: 'AC102' },
      { text: 'FB127' },
      { text: 'FB135' },
      { text: 'BLANK1' },
    ]);
    expect(findDecoratedText(knownSec, 'Spec Title')).toEqual({
      topLabel: 'Spec Title',
      text: 'HOOK',
      wrapText: true,
    });
    expect(findTextInput(knownSec, 'specTitle', 'submittal-ffe')).toBeUndefined();

    // 2. Typing 'HOOK' (Spec Title value, NOT Spec Tag key) does NOT match AC102 -> unlocked editable textInput
    const nameCandidateRes = await callOnChange('HOOK');
    const nameCandidateSec = findSection(getCard(nameCandidateRes.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(nameCandidateSec, 'Spec Title')).toBeUndefined();
    expect(findTextInput(nameCandidateSec, 'specTitle', 'submittal-ffe')).toBeDefined();

    // 3. Known key with blank Spec Title ('BLANK1') -> unlocked editable textInput
    const blankPropRes = await callOnChange('BLANK1');
    const blankPropSec = findSection(getCard(blankPropRes.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(blankPropSec, 'Spec Title')).toBeUndefined();
    expect(findTextInput(blankPropSec, 'specTitle', 'submittal-ffe')).toBeDefined();

    // 4. Blank Spec Tag -> unlocked editable textInput
    const blankTagRes = await callOnChange('');
    const blankTagSec = findSection(getCard(blankTagRes.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(blankTagSec, 'Spec Title')).toBeUndefined();
    expect(findTextInput(blankTagSec, 'specTitle', 'submittal-ffe')).toBeDefined();

    // 5. Custom Spec Tag -> unlocked editable textInput with ZERO DocumentLog writes
    const customRes = await callOnChange('XX100');
    const customSec = findSection(getCard(customRes.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(customSec, 'Spec Title')).toBeUndefined();
    expect(findTextInput(customSec, 'specTitle', 'submittal-ffe')).toBeDefined();
    expect(sim.batchUpdates).toHaveLength(0);

    // 6. Missing log -> unlocked editable textInput
    nock.cleanAll();
    nock('https://www.googleapis.com')
      .persist()
      .get('/drive/v3/drives')
      .query(true)
      .reply(200, { drives: [{ id: DRIVE_ID, name: SPACE_NAME }] });
    nock('https://www.googleapis.com')
      .persist()
      .get('/drive/v3/files')
      .query((q) => typeof q.q === 'string' && q.q.includes("name contains 'Document Log'"))
      .reply(200, { files: [] });
    const missingLogRes = await callOnChange('AC102');
    const missingLogSec = findSection(getCard(missingLogRes.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(missingLogSec, 'Spec Title')).toBeUndefined();
    expect(findTextInput(missingLogSec, 'specTitle', 'submittal-ffe')).toBeDefined();

    // 7. Sheets timeout -> unlocked editable textInput
    nock.cleanAll();
    mockDriveForFfe([{ id: logId, name: `${SPACE_NAME} Document Log` }]);
    nock('https://sheets.googleapis.com')
      .persist()
      .get(`/v4/spreadsheets/${logId}`)
      .query(true)
      .delay(300)
      .reply(200, { spreadsheetId: logId, sheets: [], namedRanges: [] });
    const timeoutRes = await callOnChange('AC102');
    const timeoutSec = findSection(getCard(timeoutRes.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(timeoutSec, 'Spec Title')).toBeUndefined();
    expect(findTextInput(timeoutSec, 'specTitle', 'submittal-ffe')).toBeDefined();
  });

  it('requires Spec Title when custom Spec Tag is submitted, writes custom Spec Tag + Spec Title atomically when both provided, and coalesces/backfills/allows shared titles across submissions', async () => {
    const logId = 'log-ffe-362-write';
    const sim = createFfeSim(logId);
    mountSpreadsheetNock(sim);
    mockDriveForFfe([{ id: logId, name: `${SPACE_NAME} Document Log` }]);

    const submitAddon = async (fields: Record<string, string | undefined>) => {
      const formInputs: Record<string, { stringInputs: { value: string[] } }> = {
        SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
        [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
        [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
        SelectFiles: { stringInputs: { value: ['file-ffe-362'] } },
      };
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) {
          formInputs[getDocumentInfoWidgetName(k, 'submittal-ffe')] = { stringInputs: { value: [v] } };
        }
      }
      return app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt' },
        payload: {
          authorizationEventObject: { userOAuthToken: 'ya29.token' },
          drive: {
            selectedItems: [{ id: 'file-ffe-362', title: 'Upload.pdf', mimeType: 'application/pdf' }],
          },
          commonEventObject: {
            hostApp: 'DRIVE',
            parameters: { action: 'processDocument' },
            formInputs,
          },
        },
      });
    };

    // 1. Custom specTag 'XX100' without specTitle -> blocked with validation error, 0 batchUpdates
    const missingTitleRes = await submitAddon({
      status: 'Open',
      specTag: 'XX100',
      revision: '0',
      vendor: 'BM',
      date: '261125',
      contact: 'INC',
      action: 'REC',
    });
    expect(missingTitleRes.statusCode).toBe(200);
    expect(missingTitleRes.payload).toContain('specTitle');
    expect(sim.batchUpdates).toHaveLength(0);

    // 2. Custom specTag 'XX100' + relatedTag 'xx100' + specTitle 'Custom Lounge Chair' -> coalesced into 1 _Config row
    const coalescedRes = await submitAddon({
      status: 'Open',
      specTag: 'XX100',
      relatedTag: 'xx100',
      revision: '0',
      specTitle: 'Custom Lounge Chair',
      vendor: 'BM',
      date: '261125',
      contact: 'INC',
      action: 'REC',
    });
    expect(coalescedRes.statusCode).toBe(200);
    expect(coalescedRes.payload).toContain('processed successfully');
    expect(sim.batchUpdates).toHaveLength(1);

    // 3. Known specTag 'AC102' (with specTitle omitted as decoratedText) + new relatedTag 'REL200' -> succeeds, inserts REL200 with blank Spec Title
    const relatedOnlyRes = await submitAddon({
      status: 'Open',
      specTag: 'ac102',
      relatedTag: 'REL200',
      revision: '0',
      vendor: 'BM',
      date: '261125',
      contact: 'INC',
      action: 'REC',
    });
    expect(relatedOnlyRes.statusCode).toBe(200);
    expect(relatedOnlyRes.payload).toContain('processed successfully');
    expect(sim.batchUpdates).toHaveLength(2);

    // 4. Later submittal using specTag 'rel200' with non-blank specTitle -> backfills existing REL200 row without duplicate row
    const backfillRes = await submitAddon({
      status: 'Open',
      specTag: 'rel200',
      revision: '0',
      specTitle: 'Backfilled Sconce',
      vendor: 'BM',
      date: '261125',
      contact: 'INC',
      action: 'REC',
    });
    expect(backfillRes.statusCode).toBe(200);
    expect(backfillRes.payload).toContain('processed successfully');
    expect(sim.batchUpdates).toHaveLength(3);

    // 5. Distinct key 'FB999' sharing 'FABRIC - LEATHER' title with FB127 -> allowed as new row
    const sharedTitleRes = await submitAddon({
      status: 'Open',
      specTag: 'FB999',
      revision: '0',
      specTitle: 'FABRIC - LEATHER',
      vendor: 'BM',
      date: '261125',
      contact: 'INC',
      action: 'REC',
    });
    expect(sharedTitleRes.statusCode).toBe(200);
    expect(sharedTitleRes.payload).toContain('processed successfully');
    expect(sim.batchUpdates).toHaveLength(4);

    const cfgGrid = sim.sheets[1].grid;
    const specsNr = sim.namedRanges.find((nr) => nr.name === 'Options_Submittal_FFE_Specs')!;
    expect(
      cfgGrid
        .slice(specsNr.range.startRowIndex, specsNr.range.endRowIndex)
        .map((r) => r.slice(15, 17).map((cell) => cell.value))
    ).toEqual([
      ['Spec Tag', 'Spec Title'],
      ['AC102', 'HOOK'],
      ['FB127', 'FABRIC - LEATHER'],
      ['FB135', 'FABRIC - LEATHER'],
      ['BLANK1', ''],
      ['XX100', 'Custom Lounge Chair'],
      ['REL200', 'Backfilled Sconce'],
      ['FB999', 'FABRIC - LEATHER'],
      ['---', ''],
    ]);
    expect(sim.namedRanges.find((nr) => nr.name === 'Validation_Submittal_FFE_Specs')?.range).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 8,
    });
  });

  it('authoritatively re-derives non-blank LinkedField specTitle on POST /documents when known Spec Tag is submitted', async () => {
    const logId = 'log-ffe-362-api';
    const sim = createFfeSim(logId);
    mountSpreadsheetNock(sim);
    mockDriveForFfe([{ id: logId, name: `${SPACE_NAME} Document Log` }]);

    const dispatchedDocuments: Array<Record<string, unknown>> = [];
    const postApp = createApp({
      manifestProvider: new AppManifestProvider({ manifestPath: MANIFEST_PATH }),
      authVerifier: createAuthVerifier(),
      skipSpaceValidation: true,
      lookupTimeoutMs: 120,
      activityEngine: {
        dispatch: async (activity, context) => {
          if (activity.type === 'WRITE_LOG' && context?.document) {
            dispatchedDocuments.push(context.document as unknown as Record<string, unknown>);
            await postApp.documentLogService!.writeLog({
              document: {
                type: context.document.type,
                data: context.document.data,
                ...(context.document.calculated !== undefined
                  ? { calculated: context.document.calculated }
                  : {}),
                ...(context.document.space !== undefined ? { space: context.document.space } : {}),
              },
              fileUri: 'https://drive.google.com/file/d/file-ffe-362/view',
            });
          }
        },
      },
    });
    await postApp.initialize();

    const res = await postApp.server.inject({
      method: 'POST',
      url: '/documents?eventName=onSubmit',
      payload: {
        type: 'submittal-ffe',
        space: {
          id: DRIVE_ID,
          typeId: 'projects',
          name: SPACE_NAME,
          abstractStorageId: DRIVE_ID,
        },
        data: {
          status: 'Open',
          specTag: 'ac102',
          revision: '1',
          specTitle: 'Caller Attempted Override',
          vendor: 'BM',
          date: '261125',
          contact: 'INC',
          action: 'REC',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.data.specTag).toEqual({ key: 'AC102', name: 'HOOK' });
    expect(body.data.data.specTitle).toBe('HOOK');
    expect(dispatchedDocuments).toHaveLength(1);
    expect((dispatchedDocuments[0].data as Record<string, unknown>).specTitle).toBe('HOOK');
    expect(sim.batchUpdates).toHaveLength(1);
    // Known AC102 did not insert/modify _Config Specs
    const specsNr = sim.namedRanges.find((nr) => nr.name === 'Options_Submittal_FFE_Specs')!;
    expect(specsNr.range.endRowIndex).toBe(6);
  });

  it('refreshes lockedFields on SelectDocumentLog switch in ambiguous spaces while keeping typed inputs intact', async () => {
    const logAId = 'log-ffe-ambig-a';
    const logBId = 'log-ffe-ambig-b';
    const simA = createFfeSim(logAId, [
      ['Spec Tag', 'Spec Title'],
      ['AC102', 'HOOK FROM LOG A'],
      ['---', ''],
    ]);
    const simB = createFfeSim(logBId, [
      ['Spec Tag', 'Spec Title'],
      ['AC102', ''],
      ['---', ''],
    ]);
    mountSpreadsheetNock(simA);
    mountSpreadsheetNock(simB);
    mockDriveForFfe([
      { id: logAId, name: `${SPACE_NAME} Document Log`, modifiedTime: '2026-11-20T12:00:00Z' },
      { id: logBId, name: `${SPACE_NAME} Document Log Archive`, modifiedTime: '2026-11-10T12:00:00Z' },
    ]);

    // 1. Select log-a -> AC102 locks Spec Title to 'HOOK FROM LOG A'
    const resA = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [{ id: 'file-ffe-362', title: 'Upload.pdf', mimeType: 'application/pdf' }],
        },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [logAId] } },
            SelectFiles: { stringInputs: { value: ['file-ffe-362'] } },
            [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: ['AC102'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-ffe')]: { stringInputs: { value: ['2'] } },
            [getDocumentInfoWidgetName('notes', 'submittal-ffe')]: { stringInputs: { value: ['Keep typed notes'] } },
          },
        },
      },
    });
    expect(resA.statusCode).toBe(200);
    const secA = findSection(getCard(resA.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(secA, 'Spec Title')?.text).toBe('HOOK FROM LOG A');
    expect(findTextInput(secA, 'specTag', 'submittal-ffe')?.value).toBe('AC102');
    expect(findTextInput(secA, 'revision', 'submittal-ffe')?.value).toBe('2');
    expect(findTextInput(secA, 'notes', 'submittal-ffe')?.value).toBe('Keep typed notes');

    // 2. Switch SelectDocumentLog to log-b (where AC102 has blank Spec Title) -> Spec Title unlocks, typed inputs stay intact
    const resB = await app.server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: { authorization: 'Bearer valid-jwt' },
      payload: {
        authorizationEventObject: { userOAuthToken: 'ya29.token' },
        drive: {
          selectedItems: [{ id: 'file-ffe-362', title: 'Upload.pdf', mimeType: 'application/pdf' }],
        },
        commonEventObject: {
          hostApp: 'DRIVE',
          parameters: { action: 'onFormChange', previousSelectedLogId: logAId, previousSpaceId: DRIVE_ID },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
            [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: [SPACE_NAME] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            [SELECT_DOCUMENT_LOG_KEY]: { stringInputs: { value: [logBId] } },
            SelectFiles: { stringInputs: { value: ['file-ffe-362'] } },
            [getDocumentInfoWidgetName('specTag', 'submittal-ffe')]: { stringInputs: { value: ['AC102'] } },
            [getDocumentInfoWidgetName('revision', 'submittal-ffe')]: { stringInputs: { value: ['2'] } },
            [getDocumentInfoWidgetName('notes', 'submittal-ffe')]: { stringInputs: { value: ['Keep typed notes'] } },
          },
        },
      },
    });
    expect(resB.statusCode).toBe(200);
    const secB = findSection(getCard(resB.payload, 'updateCard'), 'Document Data');
    expect(findDecoratedText(secB, 'Spec Title')).toBeUndefined();
    expect(findTextInput(secB, 'specTitle', 'submittal-ffe')).toBeDefined();
    expect(findTextInput(secB, 'specTag', 'submittal-ffe')?.value).toBe('AC102');
    expect(findTextInput(secB, 'revision', 'submittal-ffe')?.value).toBe('2');
    expect(findTextInput(secB, 'notes', 'submittal-ffe')?.value).toBe('Keep typed notes');
  });
});

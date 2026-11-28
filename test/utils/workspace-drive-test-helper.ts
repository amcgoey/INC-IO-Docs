import * as path from 'node:path';
import { vi } from 'vitest';
import nock from 'nock';
import { PDFDocument } from 'pdf-lib';
import { createApp, type AppInstance } from '../../src/app/server';
import type { WorkspaceAuthVerifierPort } from '../../src/infrastructure/workspace-addon/api';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import type { DocumentSpaceStoragePort } from '../../src/features/document-space/ports';

export interface DriveIntegrationContext {
  app: AppInstance;
  manifestProvider: AppManifestProvider;
  mockAuthVerifier: WorkspaceAuthVerifierPort;
  mockStorageAdapter: DocumentSpaceStoragePort;
}

/**
 * Creates and initializes an isolated AppInstance wired with standard Drive test
 * auth and space storage mocks.
 */
export async function createDriveIntegrationContext(): Promise<DriveIntegrationContext> {
  const mockAuthVerifier: WorkspaceAuthVerifierPort = {
    verifyToken: vi.fn().mockImplementation(async (header?: string) => {
      if (header && header.startsWith('Bearer valid-')) {
        return {
          isValid: true,
          payload: { email: 'test-user@example.com', sub: 'user-123' },
        };
      }
      return {
        isValid: false,
        error: 'Invalid ID token signature',
      };
    }),
  };

  const mockStorageAdapter: DocumentSpaceStoragePort = {
    fetchSpaces: vi.fn().mockImplementation(async (_config, typeId: string) => {
      if (typeId === 'projects') {
        return [
          {
            id: 'space-projects-1',
            typeId: 'projects',
            name: 'Active Projects',
            abstractStorageId: 'shared-drive-proj-root',
          },
          {
            id: 'projects-shared-drive-001',
            typeId: 'projects',
            name: 'Projects Shared Drive 001',
            abstractStorageId: 'projects-shared-drive-001',
          },
        ];
      }
      if (typeId === 'proposals') {
        return [
          {
            id: 'space-proposals-1',
            typeId: 'proposals',
            name: 'Client Proposals',
            abstractStorageId: 'folder-opp-root',
          },
        ];
      }
      return [];
    }),
    resolveStorageLocation: vi.fn().mockImplementation(async (abstractStorageId: string) => ({
      provider: 'google_drive',
      abstractStorageId,
    })),
  };

  const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
  const manifestProvider = new AppManifestProvider({ manifestPath });
  const app = createApp({
    manifestProvider,
    authVerifier: mockAuthVerifier,
    skipSpaceValidation: true,
    storageAdapter: mockStorageAdapter,
  });

  await app.initialize();
  return { app, manifestProvider, mockAuthVerifier, mockStorageAdapter };
}

let cachedFlatPdfBufferPromise: Promise<Buffer> | undefined;

/**
 * Returns a module-scoped cached Buffer of an empty flat PDF document.
 */
export function getCachedFlatPdfBuffer(): Promise<Buffer> {
  if (!cachedFlatPdfBufferPromise) {
    cachedFlatPdfBufferPromise = PDFDocument.create()
      .then((doc) => doc.save())
      .then((bytes) => Buffer.from(bytes));
  }
  return cachedFlatPdfBufferPromise;
}

export function mockDynamicValidationProject({
  sharedDriveId,
  adminFolderId,
  commFolderId,
  contactFolderId,
  contactName,
}: {
  sharedDriveId: string;
  adminFolderId: string;
  commFolderId: string;
  contactFolderId: string;
  contactName: string;
}): void {
  // resolveTargetFolder step 1: list folders in shared drive root
  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes(`'${sharedDriveId}' in parents`) && !q.q.includes('name ='))
    .reply(200, { files: [{ id: adminFolderId, name: '1 Admin' }] });

  // resolveTargetFolder step 2: list folders in 1 Admin
  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes(`'${adminFolderId}' in parents`) && !q.q.includes('name ='))
    .reply(200, { files: [{ id: commFolderId, name: 'Communication' }] });

  // executeValidationQuery: check contact folder exists
  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes(`'${commFolderId}' in parents`) && q.q.includes(`name = '${contactName}'`))
    .reply(200, { files: [{ id: contactFolderId, name: contactName }] });
}

export function mockDynamicValidationProposal({
  oppFolderId,
  commFolderId,
  contactFolderId,
  contactName,
}: {
  oppFolderId: string;
  commFolderId: string;
  contactFolderId: string;
  contactName: string;
}): void {
  // resolveTargetFolder step 1: list folders in opp folder root
  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes(`'${oppFolderId}' in parents`) && !q.q.includes('name ='))
    .reply(200, { files: [{ id: commFolderId, name: 'Communications' }] });

  // executeValidationQuery: check contact folder exists
  nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query((q) => typeof q.q === 'string' && q.q.includes(`'${commFolderId}' in parents`) && q.q.includes(`name = '${contactName}'`))
    .reply(200, { files: [{ id: contactFolderId, name: contactName }] });
}

export const CONFIG_STATUSES = [
  ['Status'],
  ['Open'],
  ['Closed'],
  ['Waiting'],
  ['Manager'],
  ['Billed'],
  ['---'],
];

export const CONFIG_ACTIONS = [
  ['Key', 'Name', 'Suffix', 'Order'],
  ['REC', 'Received', '', '1'],
  ['REF', 'Referred', '_REF', '2'],
  ['NR', 'Not Reviewed', '_NR', '3'],
  ['REJ', 'Rejected', '_REJ', '4'],
  ['RR', 'Revise & Resubmit', '_RR', '5'],
  ['NOC', 'No Objections As Corrected', '_NOC', '6'],
  ['NET', 'No Exceptions Taken', '_NET', '7'],
  ['---', '', '', ''],
];

export const CONFIG_ARCH_CONTACTS = [
  ['Type', 'Key', 'Name', 'Aliases'],
  ['INC', 'INC', 'INC Architecture and Design', ''],
  ['Contractor', 'PMG', 'Pavarini McGovern', ''],
  ['Architect', 'FXC', 'FX Collaborative', ''],
  ['MEP', 'IE', 'Interface Engineering', ''],
  ['Lighting', 'VLD', 'Ventresca Lighting Design', ''],
  ['Structural', 'TT', 'Thornton Tomasetti', ''],
  ['', '---', '', ''],
];

export const CONFIG_FFE_CONTACTS = [
  ['Type', 'Key', 'Name', 'Aliases'],
  ['INC', 'INC', 'INC Architecture & Design', ''],
  ['Procurement', 'BW', 'Benjamin West', ''],
  ['Lighting', 'VLD', 'Ventresca Lighting Design', ''],
  ['Brand', 'IHG', 'IHG Hotels & Resorts', ''],
  ['', '---', '', ''],
];

export const CONFIG_FFE_VENDORS = [
  ['Type', 'Key', 'Name', 'Aliases'],
  ['Casegoods', 'BM', 'Berman Falk', ''],
  ['Lighting', 'AL', 'Ashley Lighting', ''],
  ['Fabric', 'Carn', 'Carnegie', ''],
  ['Fabric', 'Delta', 'Delta', ''],
  ['Fabric', 'FDT', 'Fil Doux Textiles', ''],
  ['Lighting', 'LA', 'Light Annex', ''],
  ['Fabric', 'MH', 'Mohawk', ''],
  ['', '---', '', ''],
];

export const CONFIG_FFE_SPECS = [
  ['Tag', 'Title', 'Aliases'],
  ['AC102', 'HOOK', ''],
  ['CG104', 'BED - KING', ''],
  ['FB127', 'FABRIC - LEATHER', ''],
  ['LT159A', 'SCONCE - CORRIDOR', ''],
  ['LT159B', 'SCONCE - CORRIDOR', ''],
  ['---', '', ''],
];

export function buildConfigOptionBatchGetReply(uri: string) {
  const requestedRanges = new URL(uri, 'https://sheets.googleapis.com').searchParams.getAll('ranges');
  return {
    valueRanges: requestedRanges.map((range) => {
      if (range.includes('_Config Submittal Arch')) {
        if (range.includes('A3:A')) return { range, values: CONFIG_STATUSES };
        if (range.includes('C3:F')) return { range, values: CONFIG_ACTIONS };
        if (range.includes('H3:K')) return { range, values: CONFIG_ARCH_CONTACTS };
      }
      if (range.includes('_Config Submittal FF&E')) {
        if (range.includes('A3:A')) return { range, values: CONFIG_STATUSES };
        if (range.includes('C3:F')) return { range, values: CONFIG_ACTIONS };
        if (range.includes('H3:K')) return { range, values: CONFIG_FFE_CONTACTS };
        if (range.includes('M3:P')) return { range, values: CONFIG_FFE_VENDORS };
        if (range.includes('R3:T')) return { range, values: CONFIG_FFE_SPECS };
      }
      return { range, values: [] };
    }),
  };
}

export function mockEmptyDocumentLogSheetsRead(spreadsheetId: string, options?: { optional?: boolean }): void {
  const applyOpt = <T extends nock.Interceptor>(interceptor: T): T =>
    options?.optional ? (interceptor.optionally() as T) : interceptor;
  const sheetsScope = options?.optional
    ? nock('https://sheets.googleapis.com').persist()
    : nock('https://sheets.googleapis.com');

  applyOpt(
    sheetsScope
      .get(`/v4/spreadsheets/${spreadsheetId}`)
      .query(true)
  ).reply(200, {
    spreadsheetId,
    sheets: [
      { properties: { sheetId: 101, title: 'Submittal Arch' } },
      { properties: { sheetId: 102, title: 'Submittal FF&E' } },
      { properties: { sheetId: 103, title: '_Config Submittal Arch' } },
      { properties: { sheetId: 104, title: '_Config Submittal FF&E' } },
    ],
    namedRanges: [
      {
        namedRangeId: 'nr-arch',
        name: 'Log_Submittal_Arch',
        range: { sheetId: 101, startRowIndex: 2, endRowIndex: 21, startColumnIndex: 0, endColumnIndex: 11 },
      },
      {
        namedRangeId: 'nr-ffe',
        name: 'Log_Submittal_FFE',
        range: { sheetId: 102, startRowIndex: 2, endRowIndex: 21, startColumnIndex: 0, endColumnIndex: 12 },
      },
      {
        namedRangeId: 'nr-arch-statuses',
        name: 'Options_Submittal_Arch_Statuses',
        range: { sheetId: 103, startRowIndex: 2, endRowIndex: 2 + CONFIG_STATUSES.length, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-arch-statuses-val',
        name: 'Validation_Submittal_Arch_Statuses',
        range: { sheetId: 103, startRowIndex: 3, endRowIndex: 2 + CONFIG_STATUSES.length, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-arch-actions',
        name: 'Options_Submittal_Arch_Actions',
        range: { sheetId: 103, startRowIndex: 2, endRowIndex: 2 + CONFIG_ACTIONS.length, startColumnIndex: 2, endColumnIndex: 6 },
      },
      {
        namedRangeId: 'nr-arch-contacts',
        name: 'Options_Submittal_Arch_Contacts',
        range: { sheetId: 103, startRowIndex: 2, endRowIndex: 2 + CONFIG_ARCH_CONTACTS.length, startColumnIndex: 7, endColumnIndex: 11 },
      },
      {
        namedRangeId: 'nr-arch-contacts-val',
        name: 'Validation_Submittal_Arch_Contacts',
        range: { sheetId: 103, startRowIndex: 3, endRowIndex: 2 + CONFIG_ARCH_CONTACTS.length - 1, startColumnIndex: 8, endColumnIndex: 9 },
      },
      {
        namedRangeId: 'nr-ffe-statuses',
        name: 'Options_Submittal_FFE_Statuses',
        range: { sheetId: 104, startRowIndex: 2, endRowIndex: 2 + CONFIG_STATUSES.length, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-ffe-statuses-val',
        name: 'Validation_Submittal_FFE_Statuses',
        range: { sheetId: 104, startRowIndex: 3, endRowIndex: 2 + CONFIG_STATUSES.length, startColumnIndex: 0, endColumnIndex: 1 },
      },
      {
        namedRangeId: 'nr-ffe-actions',
        name: 'Options_Submittal_FFE_Actions',
        range: { sheetId: 104, startRowIndex: 2, endRowIndex: 2 + CONFIG_ACTIONS.length, startColumnIndex: 2, endColumnIndex: 6 },
      },
      {
        namedRangeId: 'nr-ffe-contacts',
        name: 'Options_Submittal_FFE_Contacts',
        range: { sheetId: 104, startRowIndex: 2, endRowIndex: 2 + CONFIG_FFE_CONTACTS.length, startColumnIndex: 7, endColumnIndex: 11 },
      },
      {
        namedRangeId: 'nr-ffe-contacts-val',
        name: 'Validation_Submittal_FFE_Contacts',
        range: { sheetId: 104, startRowIndex: 3, endRowIndex: 2 + CONFIG_FFE_CONTACTS.length - 1, startColumnIndex: 8, endColumnIndex: 9 },
      },
      {
        namedRangeId: 'nr-ffe-vendors',
        name: 'Options_Submittal_FFE_Vendors',
        range: { sheetId: 104, startRowIndex: 2, endRowIndex: 2 + CONFIG_FFE_VENDORS.length, startColumnIndex: 12, endColumnIndex: 16 },
      },
      {
        namedRangeId: 'nr-ffe-vendors-val',
        name: 'Validation_Submittal_FFE_Vendors',
        range: { sheetId: 104, startRowIndex: 3, endRowIndex: 2 + CONFIG_FFE_VENDORS.length - 1, startColumnIndex: 14, endColumnIndex: 15 },
      },
      {
        namedRangeId: 'nr-ffe-specs',
        name: 'Options_Submittal_FFE_Specs',
        range: { sheetId: 104, startRowIndex: 2, endRowIndex: 2 + CONFIG_FFE_SPECS.length, startColumnIndex: 17, endColumnIndex: 20 },
      },
      {
        namedRangeId: 'nr-ffe-specs-val',
        name: 'Validation_Submittal_FFE_Specs',
        range: { sheetId: 104, startRowIndex: 3, endRowIndex: 2 + CONFIG_FFE_SPECS.length - 1, startColumnIndex: 17, endColumnIndex: 18 },
      },
    ],
  });

  applyOpt(
    sheetsScope
      .get(new RegExp(`/v4/spreadsheets/${spreadsheetId}/values/.*`))
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
  ).reply(200, (uri) => {
    const isFfe = decodeURIComponent(uri).includes('Submittal FF&E');
    const headers = isFfe
      ? ['Status', 'Spec Tag', 'Related Tag', 'Revision', 'Spec Title', 'Vendor', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link']
      : ['Status', 'Section', 'Number', 'Revision', 'Title', 'Date', 'Contact', 'Action', 'Notes', 'Calc Link'];
    return { values: [headers, ['Formula Row'], ['<--->'], [], ['<--->']] };
  });

  applyOpt(
    sheetsScope
      .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMATTED_VALUE')
  ).reply(200, (uri) => buildConfigOptionBatchGetReply(uri));

  applyOpt(
    sheetsScope
      .get(`/v4/spreadsheets/${spreadsheetId}/values:batchGet`)
      .query((q) => q.valueRenderOption === 'FORMULA')
  ).reply(200, {
    valueRanges: [{ values: [['Formula Row']] }],
  });
}

export function mockDocumentLogSearch(options: {
  sharedDriveId?: string;
  fileId?: string;
  name?: string;
  webViewLink?: string;
} = {}) {
  const sharedDriveId = options.sharedDriveId ?? 'projects-shared-drive-001';
  const fileId = options.fileId ?? `log-${sharedDriveId}`;
  const name = options.name ?? 'Projects Shared Drive 001 Document Log';
  mockEmptyDocumentLogSheetsRead(fileId, { optional: true });
  return nock('https://www.googleapis.com')
    .get('/drive/v3/files')
    .query(
      (q) =>
        typeof q.q === 'string' &&
        q.q.includes("name contains 'Document Log'") &&
        q.driveId === sharedDriveId
    )
    .reply(200, {
      files: [
        {
          id: fileId,
          name,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          webViewLink:
            options.webViewLink ?? `https://docs.google.com/spreadsheets/d/${fileId}/edit`,
        },
      ],
    });
}

import * as path from 'node:path';
import { expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from 'googleapis';
import { createDocumentLogWiring, type DocumentLogWiring } from '../../src/app/document-log.wiring';
import { createDocumentSpaceFeatureWiring } from '../../src/app/document-space.wiring';
import {
  createDocumentFeatureWiring,
  createDocumentServiceFactory,
} from '../../src/app/document.wiring';
import { createLookupOptionsWiring } from '../../src/app/lookup-options.wiring';
import { createSourceParserWiring, type SourceParserWiring } from '../../src/app/source-parser.wiring';
import type { DocumentServiceFactory } from '../../src/app/ui-process-manager.wiring';
import type { CopyDocumentLogResult } from '../../src/features/document-log';
import { GoogleDriveClient } from '../../src/infrastructure/drive/drive-client';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { GoogleSheetsClient, type PositiveTableTarget } from '../../src/infrastructure/sheets';
import { HandlebarsAdapter } from '../../src/infrastructure/template-engine/handlebars-adapter';
import {
  getDocumentLogTestFolderId,
  resolveLiveGoogleAuth,
} from '../e2e/utils/live-google-auth';
import {
  DEFAULT_LIVE_RETRY_OPTIONS,
  createLiveSheetsApi,
  loadDocumentLogSampleFixture,
} from '../e2e/utils/live-sheets-helper';

export const sampleFixture = loadDocumentLogSampleFixture();
export const TEST_FOLDER_ID = getDocumentLogTestFolderId();

export function expectAliasesHeaderNote(note: string | undefined): void {
  expect(note?.trim().length).toBeGreaterThan(0);
  expect(note).toMatch(/""/);
  expect(note).toMatch(/case-?sensitiv/i);
}

export interface CleanupTracker {
  track: (id: string | undefined) => void;
  trashAll: (driveClient: GoogleDriveClient) => Promise<void>;
}

export function createCleanupTracker(): CleanupTracker {
  const cleanupIds: string[] = [];

  const track = (id: string | undefined): void => {
    if (!id || id.trim().length === 0) {
      return;
    }
    if (id === TEST_FOLDER_ID || id === sampleFixture.metadata.templateSpreadsheetId) {
      return;
    }
    if (!cleanupIds.includes(id)) {
      cleanupIds.push(id);
    }
  };

  const trashAll = async (driveClient: GoogleDriveClient): Promise<void> => {
    for (const id of [...cleanupIds].reverse()) {
      try {
        await driveClient.trash(id);
      } catch {
        // Best-effort cleanup of every created artifact
      }
    }
  };

  return { track, trashAll };
}

export interface DocumentLogLiveWiring {
  driveClient: GoogleDriveClient;
  sheetsApi: sheets_v4.Sheets;
  sheetsClient: GoogleSheetsClient;
  logWiring: DocumentLogWiring;
  sourceParserWiring: SourceParserWiring;
  documentServiceFactory: DocumentServiceFactory;
}

export async function initializeDocumentLogLiveWiring(): Promise<DocumentLogLiveWiring> {
  if (!TEST_FOLDER_ID) {
    throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live DocumentLog E2E tests.');
  }

  const auth = resolveLiveGoogleAuth();
  const driveClient = new GoogleDriveClient({
    auth,
    retryOptions: DEFAULT_LIVE_RETRY_OPTIONS,
  });
  const sheetsApi = createLiveSheetsApi(auth);
  const sheetsClient = new GoogleSheetsClient({
    sheets: sheetsApi,
    retryOptions: DEFAULT_LIVE_RETRY_OPTIONS,
  });

  const manifestProvider = new AppManifestProvider({
    manifestPath: path.resolve(__dirname, '../../assets/manifest.json'),
  });
  const handlebars = new HandlebarsAdapter();
  const { documentSchemaRegistry, compiledSchemaRegistry } = createDocumentFeatureWiring({
    manifestProvider,
    templateEvaluator: handlebars,
  });
  await compiledSchemaRegistry.initialize();

  const logWiring = createDocumentLogWiring({
    manifestProvider,
    driveClient,
    sheetsClient,
    configProvider: manifestProvider,
    templateEvaluator: handlebars,
  });
  await logWiring.logSchemaRegistry.initialize();

  const lookupOptionsWiring = createLookupOptionsWiring({
    manifestProvider,
    documentSchemaRegistry,
    driveClient,
    configProvider: manifestProvider,
    getDocumentLogService: (ctx) => logWiring.getPerRequestService(ctx),
    ensureDocumentLogInitialized: () => logWiring.logSchemaRegistry.initialize(),
  });

  const spaceWiring = createDocumentSpaceFeatureWiring({
    rawManifestProvider: manifestProvider,
    driveClient,
  });
  await spaceWiring.documentSpaceService.initialize();

  const sourceParserWiring = createSourceParserWiring({
    spaceTypesProvider: spaceWiring.documentSpaceService,
    manifestProvider,
    driveClient,
    configProvider: manifestProvider,
    templateEvaluator: handlebars,
    getCanonicalOptionsProvider: (ctx) => lookupOptionsWiring.createCanonicalOptionsProvider(ctx),
  });
  await sourceParserWiring.parseSchemaRegistry.initialize();

  const documentServiceFactory = createDocumentServiceFactory({
    manifestProvider,
    documentSchemaRegistry,
    templateEvaluator: handlebars,
    compiledSchemaRegistry,
    configProvider: manifestProvider,
    driveClient,
    documentLogService: logWiring.documentLogService,
    ensureDocumentLogInitialized: () => logWiring.logSchemaRegistry.initialize(),
    getDynamicValidator: (requestContext) =>
      lookupOptionsWiring.createDynamicValidator(requestContext),
    createAdditionalActivityHandlers: (context, requestContext) => {
      const effectiveCtx = requestContext ?? context;
      const sharedLookup = lookupOptionsWiring.getPerRequestLookupOptions(effectiveCtx);
      return [
        logWiring.createPerRequestActivityHandler(effectiveCtx, {
          ...(context.selectedLogId !== undefined ? { selectedLogId: context.selectedLogId } : {}),
          onWriteLogSuccess: () => sharedLookup.invalidate(),
        }),
      ];
    },
  });

  return {
    driveClient,
    sheetsApi,
    sheetsClient,
    logWiring,
    sourceParserWiring,
    documentServiceFactory,
  };
}

export interface ScratchSpaceProvisioning {
  spaceName: string;
  spaceFolderId: string;
  space: { id: string; typeId: string; name: string; abstractStorageId: string };
  copyResult: CopyDocumentLogResult;
  spreadsheetId: string;
  adminFolderId: string | undefined;
}

export async function provisionDocumentLogScratchSpace(params: {
  driveClient: GoogleDriveClient;
  logWiring: DocumentLogWiring;
  spaceName: string;
  spaceId: string;
  trackCleanupId: (id: string | undefined) => void;
}): Promise<ScratchSpaceProvisioning> {
  if (!TEST_FOLDER_ID) {
    throw new Error('DOCUMENT_LOG_TEST_FOLDER_ID is required for live DocumentLog E2E tests.');
  }

  const { driveClient, logWiring, spaceName, spaceId, trackCleanupId } = params;
  const spaceFolder = await driveClient.findOrCreateFolder(TEST_FOLDER_ID, spaceName);
  trackCleanupId(spaceFolder.id);

  const space = {
    id: spaceId,
    typeId: 'proposals',
    name: spaceName,
    abstractStorageId: spaceFolder.id,
  };

  const copyResult = await logWiring.documentLogService.copyLog(space);
  const spreadsheetId = copyResult.candidate.id;
  let adminFolderId: string | undefined;
  const copiedParentId = copyResult.candidate.parents?.[0];
  if (copiedParentId && copiedParentId !== spaceFolder.id) {
    adminFolderId = copiedParentId;
  } else {
    try {
      const resolvedAdmin = await driveClient.resolveFolderPath(spaceFolder.id, ['1 Admin']);
      adminFolderId = resolvedAdmin.id;
    } catch {
      // Verified in test assertions; afterAll also performs best-effort cleanup
    }
  }
  trackCleanupId(adminFolderId);
  trackCleanupId(spreadsheetId);

  return {
    spaceName,
    spaceFolderId: spaceFolder.id,
    space,
    copyResult,
    spreadsheetId,
    adminFolderId,
  };
}

export async function cleanupScratchSpace(params: {
  driveClient: GoogleDriveClient | undefined;
  spaceFolderId: string | undefined;
  adminFolderId: string | undefined;
  tracker: CleanupTracker;
}): Promise<void> {
  const { driveClient, spaceFolderId, adminFolderId, tracker } = params;
  if (!driveClient) {
    return;
  }
  if (spaceFolderId && !adminFolderId) {
    try {
      const adminFolder = await driveClient.resolveFolderPath(spaceFolderId, ['1 Admin']);
      tracker.track(adminFolder.id);
    } catch {
      // Best-effort discovery if copyLog failed after creating 1 Admin
    }
  }
  await tracker.trashAll(driveClient);
}

export async function uploadDummyPdf(params: {
  driveClient: GoogleDriveClient;
  targetFolderId: string;
  fileName: string;
  textContent: string;
  trackCleanupId: (id: string | undefined) => void;
}): Promise<{ id: string; name: string }> {
  const { driveClient, targetFolderId, fileName, textContent, trackCleanupId } = params;
  const dummyPdfDoc = await PDFDocument.create();
  dummyPdfDoc.addPage([612, 792]).drawText(textContent);
  const dummyPdfBytes = Buffer.from(await dummyPdfDoc.save());

  const uploaded = await driveClient.saveBuffer(dummyPdfBytes, {
    action: 'create',
    name: fileName,
    targetFolderId,
    mimeType: 'application/pdf',
  });
  trackCleanupId(uploaded.id);
  return { id: uploaded.id, name: fileName };
}

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

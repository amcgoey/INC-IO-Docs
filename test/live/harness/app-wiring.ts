import * as path from 'node:path';
import type { GoogleAuth, OAuth2Client } from 'google-auth-library';
// nosemgrep: adapter-leakage-warning
import type { drive_v3 } from '@googleapis/drive';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from '@googleapis/sheets';
import { createDocumentLogWiring, type DocumentLogWiring } from '../../../src/app/document-log.wiring';
import {
  createDocumentSpaceFeatureWiring,
  createDocumentSpaceServiceFactory,
  memoizeDocumentSpaceServiceFactory,
  type DocumentSpaceFeatureWiring,
} from '../../../src/app/document-space.wiring';
import {
  createDocumentFeatureWiring,
  createDocumentServiceFactory,
} from '../../../src/app/document.wiring';
import {
  createLookupOptionsWiring,
  type LookupOptionsWiring,
} from '../../../src/app/lookup-options.wiring';
import type { CompositeManifestProvider } from '../../../src/app/server';
import {
  createSourceParserWiring,
  type SourceParserWiring,
} from '../../../src/app/source-parser.wiring';
import type {
  DocumentServiceFactory,
  DocumentSpaceServiceFactory,
} from '../../../src/app/ui-process-manager.wiring';
import { createRetryableInitializer } from '../../../src/app/workspace-addon.wiring';
import type {
  CompiledSchemaRegistryPort,
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
} from '../../../src/features/document/ports';
import { GoogleDriveClient } from '../../../src/infrastructure/drive/drive-client';
import {
  AppManifestProvider,
  createMaxInMemoryFileBytesProvider,
} from '../../../src/infrastructure/manifest/app-manifest-provider';
import { PdfProcessor } from '../../../src/infrastructure/pdf/pdf-processor';
import { GoogleSheetsClient } from '../../../src/infrastructure/sheets';
import { HandlebarsAdapter } from '../../../src/infrastructure/template-engine/handlebars-adapter';
import {
  createApiCallTracker,
  type ApiCallTracker,
} from './api-counter';
import {
  createLiveDriveApi,
  resolveLiveGoogleAuth,
} from './auth-clients';
import {
  DEFAULT_LIVE_RETRY_OPTIONS,
  createLiveSheetsApi,
  type LiveSheetsRetryOptions,
} from './sheets-helpers';

export const DEFAULT_LIVE_LOOKUP_TIMEOUT_MS = 25_000;

export interface LiveAppWiringOptions {
  auth?: OAuth2Client | GoogleAuth | undefined;
  retryOptions?: LiveSheetsRetryOptions | undefined;
  lookupTimeoutMs?: number | undefined;
  manifestPath?: string | undefined;
  manifestProvider?: CompositeManifestProvider | undefined;
  driveApi?: drive_v3.Drive | undefined;
  sheetsApi?: sheets_v4.Sheets | undefined;
  apiTracker?: ApiCallTracker | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
  pdfProcessor?: PdfProcessor | undefined;
}

export interface LiveAppWiring {
  apiTracker: ApiCallTracker;
  driveApi: drive_v3.Drive;
  driveClient: GoogleDriveClient;
  sheetsApi: sheets_v4.Sheets;
  sheetsClient: GoogleSheetsClient;
  manifestProvider: CompositeManifestProvider;
  pdfProcessor: PdfProcessor;
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  compiledSchemaRegistry: CompiledSchemaRegistryPort;
  documentSpaceWiring: DocumentSpaceFeatureWiring;
  createDocumentSpaceService: DocumentSpaceServiceFactory;
  logWiring: DocumentLogWiring;
  lookupOptionsWiring: LookupOptionsWiring;
  sourceParserWiring: SourceParserWiring;
  documentServiceFactory: DocumentServiceFactory;
  lookupTimeoutMs: number;
}

/**
 * Creates the application/feature wiring facade for live E2E tests, matching `Workspace Addon`
 * wiring (`getOptionTablePort`, `getDocumentSpaceService`, `memoizeDocumentSpaceServiceFactory`,
 * and injectable `lookupTimeoutMs`, defaulting to `25,000 ms`) with Sheets/Drive API-call-count
 * instrumentation.
 */
export async function createLiveAppWiring(
  options?: LiveAppWiringOptions
): Promise<LiveAppWiring> {
  const apiTracker = options?.apiTracker ?? createApiCallTracker();
  const retryOptions = options?.retryOptions ?? DEFAULT_LIVE_RETRY_OPTIONS;
  const resolvedAuth =
    options?.driveApi && options?.sheetsApi
      ? undefined
      : (options?.auth ?? resolveLiveGoogleAuth());

  const rawDriveApi = options?.driveApi ?? createLiveDriveApi(resolvedAuth!);
  const driveApi = apiTracker.instrumentDriveApi(rawDriveApi);
  const driveClient = new GoogleDriveClient({
    drive: driveApi,
    retryOptions,
  });

  const rawSheetsApi = options?.sheetsApi ?? createLiveSheetsApi(resolvedAuth!);
  const sheetsApi = apiTracker.instrumentSheetsApi(rawSheetsApi);
  const sheetsClient = new GoogleSheetsClient({
    sheets: sheetsApi,
    retryOptions,
  });

  const manifestProvider: CompositeManifestProvider =
    options?.manifestProvider ??
    new AppManifestProvider({
      manifestPath:
        options?.manifestPath ?? path.resolve(__dirname, '../../../assets/manifest.json'),
    });

  const handlebars = options?.templateEvaluator ?? new HandlebarsAdapter();
  const pdfProcessor =
    options?.pdfProcessor ??
    new PdfProcessor({
      getMaxInMemoryFileBytes: createMaxInMemoryFileBytesProvider(manifestProvider),
    });

  const { documentSchemaRegistry, compiledSchemaRegistry } = createDocumentFeatureWiring({
    manifestProvider,
    templateEvaluator: handlebars,
  });
  await compiledSchemaRegistry.initialize();

  const documentSpaceWiring = createDocumentSpaceFeatureWiring({
    rawManifestProvider: manifestProvider,
    driveClient,
  });
  await documentSpaceWiring.documentSpaceService.initialize();

  const createDocumentSpaceService = memoizeDocumentSpaceServiceFactory(
    createDocumentSpaceServiceFactory({
      documentSpaceRegistry: documentSpaceWiring.documentSpaceRegistry,
      configProvider: manifestProvider,
      driveClient,
    })
  );

  const logWiring = createDocumentLogWiring({
    manifestProvider,
    driveClient,
    sheetsClient,
    configProvider: manifestProvider,
    templateEvaluator: handlebars,
  });
  const ensureDocumentLogInitialized = createRetryableInitializer(() =>
    logWiring.logSchemaRegistry.initialize()
  );
  await ensureDocumentLogInitialized();

  const lookupTimeoutMs = options?.lookupTimeoutMs ?? DEFAULT_LIVE_LOOKUP_TIMEOUT_MS;

  const lookupOptionsWiring = createLookupOptionsWiring({
    manifestProvider,
    documentSchemaRegistry,
    driveClient,
    configProvider: manifestProvider,
    timeoutMs: lookupTimeoutMs,
    getDocumentLogService: (ctx) => logWiring.getPerRequestService(ctx),
    ensureDocumentLogInitialized,
    getDocumentSpaceService: (ctx) => createDocumentSpaceService(ctx),
  });

  const sourceParserWiring = createSourceParserWiring({
    spaceTypesProvider: documentSpaceWiring.documentSpaceService,
    manifestProvider,
    driveClient,
    configProvider: manifestProvider,
    templateEvaluator: handlebars,
    pdfProcessor,
    getCanonicalOptionsProvider: (ctx) =>
      lookupOptionsWiring.createCanonicalOptionsProvider(ctx),
  });
  await sourceParserWiring.parseSchemaRegistry.initialize();

  const documentServiceFactory = createDocumentServiceFactory({
    manifestProvider,
    documentSchemaRegistry,
    templateEvaluator: handlebars,
    compiledSchemaRegistry,
    configProvider: manifestProvider,
    driveClient,
    pdfProcessor,
    documentLogService: logWiring.documentLogService,
    ensureDocumentLogInitialized,
    getDynamicValidator: (requestContext) =>
      lookupOptionsWiring.createDynamicValidator(requestContext),
    getOptionTablePort: (requestContext) =>
      lookupOptionsWiring.createOptionTableResolver(requestContext),
    getDocumentSpaceService: (ctx) => createDocumentSpaceService(ctx),
    lookupTimeoutMs,
    createAdditionalActivityHandlers: async (context, requestContext) => {
      await ensureDocumentLogInitialized();
      const effectiveCtx = requestContext ?? context;
      const sharedLookup = lookupOptionsWiring.getPerRequestLookupOptions(effectiveCtx);
      return [
        logWiring.createPerRequestActivityHandler(effectiveCtx, {
          ...(context.selectedLogId !== undefined
            ? { selectedLogId: context.selectedLogId }
            : {}),
          onWriteLogSuccess: () => sharedLookup.invalidate(),
        }),
      ];
    },
  });

  return {
    apiTracker,
    driveApi,
    driveClient,
    sheetsApi,
    sheetsClient,
    manifestProvider,
    pdfProcessor,
    documentSchemaRegistry,
    compiledSchemaRegistry,
    documentSpaceWiring,
    createDocumentSpaceService,
    logWiring,
    lookupOptionsWiring,
    sourceParserWiring,
    documentServiceFactory,
    lookupTimeoutMs,
  };
}

import jsonLogic from 'json-logic-js';
import { OAuth2Client } from 'google-auth-library';
import {
  SourceParserService,
  DriveSourceContextAdapter,
  DriveFormExtractorAdapter,
  ParseSchemaRegistryAdapter,
  type SourceParserPort,
  type SourceParserSpaceConfigPort,
  type SourceParserSpaceTypeConfig,
  type SourceParserConfigPort,
  type DriveSourceContextClientPort,
  type ParseSchemaRegistryPort,
  type RawManifestProviderPort,
  type PredicateEvaluatorPort,
  type CanonicalOptionsProviderPort,
  type FormExtractorPort,
  type FormTemplateParserPort,
  type PdfFormExtractorPort,
  type GoogleDocsFormReaderPort,
} from '../features/source-parser';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import { GoogleDocsClient } from '../infrastructure/docs';
import { PdfProcessor } from '../infrastructure/pdf/pdf-processor';
import { createMaxInMemoryFileBytesProvider } from '../infrastructure/manifest/app-manifest-provider';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { WorkspaceConfigProviderPort } from '../infrastructure/workspace-addon/config';
import type { AppConfigurationProviderPort } from '../features/document/ports';

export interface SpaceTypesProvider {
  getAllTypes?(): SourceParserSpaceTypeConfig[];
  getDocumentSpaceTypes?(): Promise<SourceParserSpaceTypeConfig[]> | SourceParserSpaceTypeConfig[];
}

export type SourceParserFactory = (
  context: WorkspaceExecutionContext,
  overrides?: { canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined }
) => SourceParserPort;

export interface SourceParserWiringOptions {
  spaceTypesProvider: SpaceTypesProvider;
  manifestProvider?: RawManifestProviderPort | undefined;
  driveClient?: GoogleDriveClient | undefined;
  driveContextClient?: DriveSourceContextClientPort | undefined;
  configProvider?: (Partial<AppConfigurationProviderPort> & Partial<WorkspaceConfigProviderPort>) | undefined;
  workspaceConfigProvider?: WorkspaceConfigProviderPort | undefined;
  predicateEvaluator?: PredicateEvaluatorPort | undefined;
  canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined;
  getCanonicalOptionsProvider?: ((context: WorkspaceExecutionContext) => CanonicalOptionsProviderPort | undefined) | undefined;
  pdfProcessor?: PdfFormExtractorPort | undefined;
  formTemplateParser?: FormTemplateParserPort | undefined;
  templateEvaluator?: unknown;
  formExtractor?: FormExtractorPort | undefined;
  googleDocsFormReader?: GoogleDocsFormReaderPort | undefined;
  docsClient?: GoogleDocsClient | undefined;
}

function resolveFormTemplateParser(candidate: unknown): FormTemplateParserPort | undefined {
  if (
    candidate !== null &&
    candidate !== undefined &&
    typeof (candidate as { parseMustacheTemplate?: unknown }).parseMustacheTemplate === 'function'
  ) {
    return candidate as FormTemplateParserPort;
  }
  return undefined;
}

export interface SourceParserWiring {
  sourceParser: SourceParserPort;
  createSourceParser: SourceParserFactory;
  parseSchemaRegistry: ParseSchemaRegistryPort;
}

function createOAuth2Client(oauthCred: string): OAuth2Client {
  const oauth2Client = new OAuth2Client();
  oauth2Client.setCredentials({ access_token: oauthCred });
  return oauth2Client;
}

function createGoogleDriveClient(
  options: SourceParserWiringOptions,
  auth?: OAuth2Client | string
): GoogleDriveClient {
  const driveAppConfigProvider: AppConfigurationProviderPort | undefined =
    options.configProvider && typeof options.configProvider.getDriveConfig === 'function'
      ? (options.configProvider as AppConfigurationProviderPort)
      : undefined;

  if (auth) {
    return new GoogleDriveClient({
      auth,
      configProvider: driveAppConfigProvider,
    });
  }

  if (options.driveClient) {
    return options.driveClient;
  }

  return new GoogleDriveClient({ configProvider: driveAppConfigProvider });
}

function resolveDriveClients(
  options: SourceParserWiringOptions,
  auth?: OAuth2Client | string
): {
  contextClient: DriveSourceContextClientPort;
  mediaClient: GoogleDriveClient | undefined;
} {
  if (options.driveContextClient) {
    return {
      contextClient: options.driveContextClient,
      mediaClient: options.formExtractor ? undefined : createGoogleDriveClient(options, auth),
    };
  }
  const sharedDriveClient = createGoogleDriveClient(options, auth);
  return {
    contextClient: sharedDriveClient,
    mediaClient: sharedDriveClient,
  };
}

function resolveDocsFormReader(
  options: SourceParserWiringOptions,
  auth?: OAuth2Client | string
): GoogleDocsFormReaderPort {
  if (options.googleDocsFormReader) {
    return options.googleDocsFormReader;
  }
  if (options.docsClient) {
    return options.docsClient;
  }
  return new GoogleDocsClient(auth ? { auth } : {});
}

export function createSourceParserWiring(
  options: SourceParserWiringOptions
): SourceParserWiring {
  const spaceConfigPort: SourceParserSpaceConfigPort = {
    getDocumentSpaceTypes: () => {
      if (typeof options.spaceTypesProvider.getAllTypes === 'function') {
        return options.spaceTypesProvider.getAllTypes();
      }
      if (typeof options.spaceTypesProvider.getDocumentSpaceTypes === 'function') {
        return options.spaceTypesProvider.getDocumentSpaceTypes();
      }
      return [];
    },
  };

  const workspaceConfigProvider: WorkspaceConfigProviderPort | undefined =
    options.workspaceConfigProvider ??
    (options.configProvider && typeof options.configProvider.getWorkspaceConfig === 'function'
      ? (options.configProvider as WorkspaceConfigProviderPort)
      : undefined);

  const configPort: SourceParserConfigPort | undefined = workspaceConfigProvider
    ? {
        getWorkspaceTimeZone: async () => {
          const wsConfig = await workspaceConfigProvider.getWorkspaceConfig();
          return wsConfig?.timeZone;
        },
      }
    : undefined;

  const formTemplateParser: FormTemplateParserPort =
    options.formTemplateParser ??
    resolveFormTemplateParser(options.templateEvaluator) ??
    new HandlebarsAdapter();
  const getMaxInMemoryFileBytes = createMaxInMemoryFileBytesProvider(options.configProvider);
  const pdfProcessor: PdfFormExtractorPort =
    options.pdfProcessor ?? new PdfProcessor({ getMaxInMemoryFileBytes });
  const parseSchemaRegistry: ParseSchemaRegistryPort = new ParseSchemaRegistryAdapter(
    options.manifestProvider,
    formTemplateParser
  );

  const predicateEvaluator: PredicateEvaluatorPort = options.predicateEvaluator ?? {
    evaluate: (rule: unknown, data: Record<string, unknown>): boolean => {
      if (rule === undefined || rule === null) {
        return true;
      }
      return Boolean(jsonLogic.apply(rule as jsonLogic.RulesLogic, data));
    },
  };

  const buildFormExtractor = (
    mediaClient: GoogleDriveClient | undefined,
    auth?: OAuth2Client | string
  ): FormExtractorPort => {
    if (options.formExtractor) {
      return options.formExtractor;
    }
    const googleDocsFormReader = resolveDocsFormReader(options, auth);
    return new DriveFormExtractorAdapter({
      driveMediaClient: mediaClient!,
      pdfProcessor,
      googleDocsFormReader,
      getMaxInMemoryFileBytes,
    });
  };

  const defaultClients = resolveDriveClients(options);
  const defaultContextAdapter = new DriveSourceContextAdapter(defaultClients.contextClient);
  const sourceParser = new SourceParserService(defaultContextAdapter, spaceConfigPort, {
    parseSchemaRegistry,
    predicateEvaluator,
    formTemplateParser,
    formExtractor: buildFormExtractor(defaultClients.mediaClient),
    ...(configPort !== undefined ? { configPort } : {}),
    ...(options.canonicalOptionsProvider !== undefined ? { canonicalOptionsProvider: options.canonicalOptionsProvider } : {}),
  });

  const createSourceParser: SourceParserFactory = (
    context: WorkspaceExecutionContext,
    overrides?: { canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined }
  ): SourceParserPort => {
    const rawCredential = context.userOAuthToken ?? context.gmail?.accessToken;
    const requestAuth = rawCredential ? createOAuth2Client(rawCredential) : undefined;
    const clients = resolveDriveClients(options, requestAuth);
    const contextAdapter = new DriveSourceContextAdapter(clients.contextClient);
    const canonicalOptionsProvider =
      overrides?.canonicalOptionsProvider ??
      (options.getCanonicalOptionsProvider ? options.getCanonicalOptionsProvider(context) : options.canonicalOptionsProvider);
    return new SourceParserService(contextAdapter, spaceConfigPort, {
      parseSchemaRegistry,
      predicateEvaluator,
      formTemplateParser,
      formExtractor: buildFormExtractor(clients.mediaClient, requestAuth),
      ...(configPort !== undefined ? { configPort } : {}),
      ...(canonicalOptionsProvider !== undefined ? { canonicalOptionsProvider } : {}),
    });
  };

  return {
    sourceParser,
    createSourceParser,
    parseSchemaRegistry,
  };
}

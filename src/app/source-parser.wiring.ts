import jsonLogic from 'json-logic-js';
import {
  SourceParserService,
  DriveSourceContextAdapter,
  ParseSchemaRegistryAdapter,
  type SourceParserPort,
  type SourceParserSpaceConfigPort,
  type SourceParserSpaceTypeConfig,
  type DriveSourceContextClientPort,
  type ParseSchemaRegistryPort,
  type RawManifestProviderPort,
  type PredicateEvaluatorPort,
  type CanonicalOptionsProviderPort,
} from '../features/source-parser';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { AppConfigurationProviderPort, DriveServicePort } from '../features/document/ports';

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
  driveService?: DriveServicePort | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  predicateEvaluator?: PredicateEvaluatorPort | undefined;
  canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined;
  getCanonicalOptionsProvider?: ((context: WorkspaceExecutionContext) => CanonicalOptionsProviderPort | undefined) | undefined;
}

export interface SourceParserWiring {
  sourceParser: SourceParserPort;
  createSourceParser: SourceParserFactory;
  parseSchemaRegistry: ParseSchemaRegistryPort;
}

function createDriveContextClient(
  options: SourceParserWiringOptions,
  token?: string
): DriveSourceContextClientPort {
  if (options.driveService) {
    return {
      getFile: async (id) => options.driveService!.getFile(id),
      listSharedDrives: options.driveClient
        ? (opts) => options.driveClient!.listSharedDrives(opts)
        : async () => ({ drives: [] }),
    };
  }

  if (token) {
    const driveClient = new GoogleDriveClient({
      auth: token,
      configProvider: options.configProvider,
    });
    return driveClient;
  }

  if (options.driveClient) {
    return options.driveClient;
  }

  return new GoogleDriveClient({ configProvider: options.configProvider });
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

  const parseSchemaRegistry: ParseSchemaRegistryPort = new ParseSchemaRegistryAdapter(options.manifestProvider);

  const predicateEvaluator: PredicateEvaluatorPort = options.predicateEvaluator ?? {
    evaluate: (rule: unknown, data: Record<string, unknown>): boolean => {
      if (rule === undefined || rule === null) {
        return true;
      }
      return Boolean(jsonLogic.apply(rule as jsonLogic.RulesLogic, data));
    },
  };

  const defaultDriveContextClient = createDriveContextClient(options);
  const defaultContextAdapter = new DriveSourceContextAdapter(defaultDriveContextClient);
  const sourceParser = new SourceParserService(defaultContextAdapter, spaceConfigPort, {
    parseSchemaRegistry,
    predicateEvaluator,
    ...(options.canonicalOptionsProvider !== undefined ? { canonicalOptionsProvider: options.canonicalOptionsProvider } : {}),
  });

  const createSourceParser: SourceParserFactory = (
    context: WorkspaceExecutionContext,
    overrides?: { canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined }
  ): SourceParserPort => {
    const token = context.userOAuthToken;
    const client = createDriveContextClient(options, token);
    const contextAdapter = new DriveSourceContextAdapter(client);
    const canonicalOptionsProvider =
      overrides?.canonicalOptionsProvider ??
      (options.getCanonicalOptionsProvider ? options.getCanonicalOptionsProvider(context) : options.canonicalOptionsProvider);
    return new SourceParserService(contextAdapter, spaceConfigPort, {
      parseSchemaRegistry,
      predicateEvaluator,
      ...(canonicalOptionsProvider !== undefined ? { canonicalOptionsProvider } : {}),
    });
  };

  return {
    sourceParser,
    createSourceParser,
    parseSchemaRegistry,
  };
}

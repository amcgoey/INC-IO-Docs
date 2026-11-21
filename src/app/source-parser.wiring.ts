import jsonLogic from 'json-logic-js';
import {
  SourceParserService,
  DriveSourceContextAdapter,
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
} from '../features/source-parser';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
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
  if (options.driveContextClient) {
    return options.driveContextClient;
  }

  const driveAppConfigProvider: AppConfigurationProviderPort | undefined =
    options.configProvider && typeof options.configProvider.getDriveConfig === 'function'
      ? (options.configProvider as AppConfigurationProviderPort)
      : undefined;

  if (token) {
    const driveClient = new GoogleDriveClient({
      auth: token,
      configProvider: driveAppConfigProvider,
    });
    return driveClient;
  }

  if (options.driveClient) {
    return options.driveClient;
  }

  return new GoogleDriveClient({ configProvider: driveAppConfigProvider });
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
    ...(configPort !== undefined ? { configPort } : {}),
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

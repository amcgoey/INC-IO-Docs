import {
  SourceParserService,
  DriveSourceContextAdapter,
  type SourceParserPort,
  type SourceParserSpaceConfigPort,
  type SourceParserSpaceTypeConfig,
  type DriveSourceContextClientPort,
} from '../features/source-parser';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';
import type { AppConfigurationProviderPort, DriveServicePort } from '../features/document/ports';

export interface SpaceTypesProvider {
  getAllTypes?(): SourceParserSpaceTypeConfig[];
  getDocumentSpaceTypes?(): Promise<SourceParserSpaceTypeConfig[]> | SourceParserSpaceTypeConfig[];
}

export type SourceParserFactory = (context: WorkspaceExecutionContext) => SourceParserPort;

export interface SourceParserWiringOptions {
  spaceTypesProvider: SpaceTypesProvider;
  driveClient?: GoogleDriveClient | undefined;
  driveService?: DriveServicePort | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
}

export interface SourceParserWiring {
  sourceParser: SourceParserPort;
  createSourceParser: SourceParserFactory;
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

  const defaultDriveContextClient = createDriveContextClient(options);
  const defaultContextAdapter = new DriveSourceContextAdapter(defaultDriveContextClient);
  const sourceParser = new SourceParserService(defaultContextAdapter, spaceConfigPort);

  const createSourceParser: SourceParserFactory = (
    context: WorkspaceExecutionContext
  ): SourceParserPort => {
    const token = context.userOAuthToken;
    const client = createDriveContextClient(options, token);
    const contextAdapter = new DriveSourceContextAdapter(client);
    return new SourceParserService(contextAdapter, spaceConfigPort);
  };

  return {
    sourceParser,
    createSourceParser,
  };
}

import { createHttpServer, type HttpServer } from '../infrastructure/http';
export { createHttpServer, type HttpServer };
import { AppManifestProvider } from '../infrastructure/manifest/app-manifest-provider';
import { HandlebarsAdapter } from '../infrastructure/template-engine/handlebars-adapter';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { AppConfigurationProviderPort, WorkspaceConfigProviderPort } from '../features/workspace/ports';
import type { RawManifestProviderPort } from '../features/document-space/ports';
import type { TemplateEvaluatorPort } from '../features/document/ports';

export interface SharedInfrastructureOptions {
  logger?: boolean | undefined;
  manifestProvider?: (AppConfigurationProviderPort & WorkspaceConfigProviderPort & RawManifestProviderPort) | undefined;
  manifestPath?: string | undefined;
  templateEvaluator?: TemplateEvaluatorPort | undefined;
}

export interface SharedInfrastructure {
  server: HttpServer;
  templateEvaluator: TemplateEvaluatorPort;
  manifestProvider: (AppConfigurationProviderPort & WorkspaceConfigProviderPort & RawManifestProviderPort) | undefined;
  driveClient: GoogleDriveClient;
}

export function createSharedInfrastructure(
  options: SharedInfrastructureOptions
): SharedInfrastructure {
  const server = createHttpServer(options.logger !== undefined ? { logger: options.logger } : {});
  const templateEvaluator = options.templateEvaluator ?? new HandlebarsAdapter();

  let manifestProvider = options.manifestProvider;
  if (!manifestProvider) {
    const manifestPath = options.manifestPath ?? process.env.APP_MANIFEST_PATH;
    if (manifestPath) {
      manifestProvider = new AppManifestProvider({ manifestPath });
    }
  }

  const driveClient = new GoogleDriveClient({ configProvider: manifestProvider });

  return {
    server,
    templateEvaluator,
    manifestProvider,
    driveClient,
  };
}


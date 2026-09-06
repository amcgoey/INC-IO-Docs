import type {
  AuthVerifierPort,
  WorkspaceConfigProviderPort,
  WorkspaceDocumentRunnerPort,
} from '../ports';
import type { DocumentSelectionState, WorkspaceUiBuilderPort } from './ui-builder';
import {
  extractWorkspaceExecutionContext,
  type WorkspaceExecutionContext,
} from '../domain';
import { buildDriveDocumentProcessCard } from './drive-document-process-card';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

export interface HttpRequest {
  body?: unknown;
  headers?: Record<string, string | string[] | undefined> | undefined;
  query?: unknown;
  params?: unknown;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteDefinition {
  method: HttpMethod;
  url: string;
  schema?: unknown;
  handler: (request: HttpRequest) => Promise<HttpResponse> | HttpResponse;
}

export interface HttpServer {
  registerRoute(route: RouteDefinition): void;
}

export interface WorkspaceFeatureApiOptions {
  authVerifier: AuthVerifierPort;
  uiBuilder: WorkspaceUiBuilderPort;
  documentService?: WorkspaceDocumentRunnerPort | undefined;
  documentSpaceService?: import('../ports').WorkspaceDocumentSpaceProviderPort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
}

function withAuthentication(
  authVerifier: AuthVerifierPort,
  handler: (request: HttpRequest) => Promise<HttpResponse>
): (request: HttpRequest) => Promise<HttpResponse> {
  return async (request: HttpRequest): Promise<HttpResponse> => {
    try {
      const authHeader = request.headers?.['authorization'] as string | undefined;
      const authResult = await authVerifier.verifyToken(authHeader);

      if (!authResult.isValid) {
        return {
          status: 401,
          body: {
            error: 'Unauthorized',
            message: authResult.error ?? 'Invalid authentication token',
          },
        };
      }

      return await handler(request);
    } catch (error) {
      return {
        status: 500,
        body: {
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Authentication processing error',
        },
      };
    }
  };
}

export function registerWorkspaceFeatureRoutes(
  router: HttpServer,
  opts: WorkspaceFeatureApiOptions
): void {
  const {
    authVerifier,
    uiBuilder,
    documentService,
    documentSpaceService,
    configProvider,
  } = opts;

  const prepareDriveDocumentProcessCardContext = async (
    context: WorkspaceExecutionContext
  ) => {
    const wsConfig = configProvider ? await configProvider.getWorkspaceConfig() : undefined;

    let spaceTypes: DocumentSelectionState['spaceTypes'] = [];
    let documentTypes: DocumentSelectionState['documentTypes'] = [];
    let spaces: string[] = [];

    const defaultSpaceType = wsConfig?.defaultDocumentSpaceType ?? 'projects';
    let allowedDocumentTypes: string[] | undefined;

    if (documentSpaceService) {
      const types = documentSpaceService.getAllTypes();
      spaceTypes = types.map((t) => ({
        text: t.displayName,
        value: t.id,
        selected: t.id === defaultSpaceType,
      }));

      const selectedType = types.find((t) => t.id === defaultSpaceType);
      if (selectedType?.allowedDocumentTypes) {
        allowedDocumentTypes = selectedType.allowedDocumentTypes;
      }

      try {
        const collection = await documentSpaceService.getCollection(defaultSpaceType);
        spaces = collection.spaces.map((s) => s.name);
        if (!allowedDocumentTypes && collection.type?.allowedDocumentTypes) {
          allowedDocumentTypes = collection.type.allowedDocumentTypes;
        }
      } catch (e) {
        console.warn(`Could not fetch collection for default space type: ${defaultSpaceType}`, e);
      }
    }

    if (documentService?.getForms) {
      const forms = await documentService.getForms();
      const filteredForms = allowedDocumentTypes
        ? forms.filter((f) => allowedDocumentTypes.includes(f.key))
        : forms;

      documentTypes = filteredForms.map((f) => ({
        text: f.name,
        value: f.key,
        selected: f.key === wsConfig?.defaultDocumentType,
      }));
    }

    const selectionContext: DocumentSelectionState = {
      spaceTypes,
      spaces,
      documentTypes,
    };

    return buildDriveDocumentProcessCard(context.selectedItems, wsConfig, uiBuilder, {
      selectionContext,
    });
  };

  router.registerRoute({
    method: 'POST',
    url: '/workspace/drive-items-selected',
    handler: withAuthentication(authVerifier, async (request) => {
      try {
        const traceHeader = request.headers?.['x-cloud-trace-context'] as string | undefined;
        const context: WorkspaceExecutionContext = extractWorkspaceExecutionContext(
          request.body,
          traceHeader
        );

        return {
          status: 200,
          body: await prepareDriveDocumentProcessCardContext(context),
        };
      } catch (error) {
        return {
          status: 200,
          body: uiBuilder.buildErrorCard(
            error instanceof Error
              ? error.message
              : 'Unknown error in /workspace/drive-items-selected'
          ),
        };
      }
    }),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/homepage',
    handler: withAuthentication(authVerifier, async (request) => {
      try {
        const traceHeader = request.headers?.['x-cloud-trace-context'] as string | undefined;
        const context: WorkspaceExecutionContext = extractWorkspaceExecutionContext(
          request.body,
          traceHeader
        );

        return {
          status: 200,
          body: await prepareDriveDocumentProcessCardContext(context),
        };
      } catch (error) {
        return {
          status: 200,
          body: uiBuilder.buildErrorCard(
            error instanceof Error ? error.message : 'Unknown error in /workspace/homepage'
          ),
        };
      }
    }),
  });
}

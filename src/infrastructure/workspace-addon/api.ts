import type { HttpServer, HttpRequest, HttpResponse } from '../http';
import {
  buildErrorCard,
} from './ui-blocks';
import {
  extractWorkspaceExecutionContext,
  type WorkspaceExecutionContext,
} from './context';

export interface WorkspaceAuthVerifier {
  verifyToken(authHeader?: string): Promise<{ isValid: boolean; error?: string | undefined; payload?: unknown }>;
}
export type WorkspaceAuthVerifierPort = WorkspaceAuthVerifier;

export interface WorkspaceUiOrchestratorPort {
  processUiEvent(context: WorkspaceExecutionContext): Promise<unknown>;
}

export interface WorkspaceAddonApiOptions {
  authVerifier: WorkspaceAuthVerifierPort;
  uiOrchestrator: WorkspaceUiOrchestratorPort;
}

function withAuthentication(
  authVerifier: WorkspaceAuthVerifier,
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

export function registerWorkspaceAddonRoutes(
  router: HttpServer,
  opts: WorkspaceAddonApiOptions
): void {
  const { authVerifier, uiOrchestrator } = opts;

  const handleUiRoute = (endpointName: string) =>
    withAuthentication(authVerifier, async (request) => {
      try {
        const traceHeader = request.headers?.['x-cloud-trace-context'] as string | undefined;
        const context: WorkspaceExecutionContext = extractWorkspaceExecutionContext(
          request.body,
          traceHeader,
          request.headers
        );
        const result = await uiOrchestrator.processUiEvent(context);
        return {
          status: 200,
          body: result,
        };
      } catch (error) {
        return {
          status: 200,
          body: buildErrorCard(
            error instanceof Error ? error.message : `Unknown error in ${endpointName}`
          ),
        };
      }
    });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/drive-items-selected',
    handler: handleUiRoute('/workspace/drive-items-selected'),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/homepage',
    handler: handleUiRoute('/workspace/homepage'),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/on-form-change',
    handler: handleUiRoute('/workspace/on-form-change'),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/action',
    handler: handleUiRoute('/workspace/action'),
  });
}

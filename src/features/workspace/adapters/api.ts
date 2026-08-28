import type { RecordServicePort } from '../../record/ports';
import type {
  AuthVerifierPort,
  WorkspaceConfigProviderPort,
} from '../ports';
import {
  extractWorkspaceExecutionContext,
  type WorkspaceExecutionContext,
} from '../domain';
import {
  buildHomepageCard,
  buildToastNotification,
  buildErrorCard,
  buildAuthorizationAction,
} from './cards';

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
  recordService?: RecordServicePort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
  authorizationUrl?: string | undefined;
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
    recordService,
    configProvider,
    authorizationUrl,
  } = opts;

  router.registerRoute({
    method: 'POST',
    url: '/workspace/homepage',
    handler: withAuthentication(authVerifier, async () => {
      try {
        const wsConfig = configProvider
          ? await configProvider.getWorkspaceConfig()
          : undefined;

        return {
          status: 200,
          body: buildHomepageCard({
            appTitle: wsConfig?.appTitle,
            actionButtonText: wsConfig?.actionButtonText,
          }),
        };
      } catch (error) {
        return {
          status: 200,
          body: buildErrorCard(
            error instanceof Error ? error.message : 'Unknown error in /workspace/homepage'
          ),
        };
      }
    }),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/action',
    handler: withAuthentication(authVerifier, async (request) => {
      try {
        const traceHeader = request.headers?.['x-cloud-trace-context'] as string | undefined;
        const context: WorkspaceExecutionContext = extractWorkspaceExecutionContext(
          request.body,
          traceHeader
        );

        if (!context.userOAuthToken) {
          return {
            status: 200,
            body: buildAuthorizationAction(authorizationUrl),
          };
        }

        const wsConfig = configProvider
          ? await configProvider.getWorkspaceConfig()
          : undefined;

        const effectiveRecordType =
          wsConfig?.defaultRecordType ?? 'test-record';
        const effectiveEventName =
          wsConfig?.defaultEventName ?? 'onSubmit';

        const selectedItem = context.selectedItems?.[0];
        const initialFileName = selectedItem?.title ?? 'selected file';

        if (recordService) {
          const bodyObj = (
            request.body && typeof request.body === 'object' ? request.body : {}
          ) as Record<string, unknown>;
          const recordPayload = bodyObj.record ?? {
            type: effectiveRecordType,
            data: {
              title: initialFileName,
            },
          };

          const result = await recordService.processRecord(
            recordPayload,
            effectiveEventName,
            context
          );
          if (!result.success) {
            const errorMessage =
              result.errors && result.errors.length > 0
                ? result.errors.join('; ')
                : 'Record processing failed';
            return {
              status: 200,
              body: buildErrorCard(errorMessage),
            };
          }
        }

        const executedResult = context.lastExecutionResult;
        const finalFileName = executedResult?.fileName ?? initialFileName;
        const destinationFolder = executedResult?.destinationFolder ?? 'Unfiled';

        return {
          status: 200,
          body: buildToastNotification(finalFileName, destinationFolder),
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error in /workspace/action';
        return {
          status: 200,
          body: buildErrorCard(errorMessage),
        };
      }
    }),
  });
}



import type { HttpRequest, HttpResponse, HttpServer } from '../../../infrastructure/http';
import type { RecordServicePort } from '../../record/ports';
import type {
  AuthVerifierPort,
  AuthVerificationResult,
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

export interface WorkspaceFeatureApiOptions {
  authVerifier: AuthVerifierPort;
  recordService?: RecordServicePort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
  defaultRecordType?: string | undefined;
  defaultEventName?: string | undefined;
  authorizationUrl?: string | undefined;
}

async function authenticateRequest(
  request: HttpRequest,
  authVerifier: AuthVerifierPort
): Promise<{ authResult: AuthVerificationResult; unauthorizedResponse?: HttpResponse }> {
  try {
    const authHeader = request.headers?.['authorization'] as string | undefined;
    const authResult = await authVerifier.verifyToken(authHeader);

    if (!authResult.isValid) {
      return {
        authResult,
        unauthorizedResponse: {
          status: 401,
          body: {
            error: 'Unauthorized',
            message: authResult.error ?? 'Invalid authentication token',
          },
        },
      };
    }

    return { authResult };
  } catch (error) {
    return {
      authResult: {
        isValid: false,
        error: error instanceof Error ? error.message : 'Authentication verification error',
      },
      unauthorizedResponse: {
        status: 401,
        body: {
          error: 'Unauthorized',
          message: error instanceof Error ? error.message : 'Authentication verification error',
        },
      },
    };
  }
}


export function registerWorkspaceFeatureRoutes(
  router: HttpServer,
  opts: WorkspaceFeatureApiOptions
): void {
  const {
    authVerifier,
    recordService,
    configProvider,
    defaultRecordType = 'test-record',
    defaultEventName = 'onSubmit',
    authorizationUrl,
  } = opts;

  router.registerRoute({
    method: 'POST',
    url: '/workspace/homepage',
    handler: async (request) => {
      try {
        const { unauthorizedResponse } = await authenticateRequest(request, authVerifier);
        if (unauthorizedResponse) {
          return unauthorizedResponse;
        }

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
    },
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/action',
    handler: async (request) => {
      try {
        const { unauthorizedResponse } = await authenticateRequest(request, authVerifier);
        if (unauthorizedResponse) {
          return unauthorizedResponse;
        }

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
          wsConfig?.defaultRecordType ?? defaultRecordType;
        const effectiveEventName =
          wsConfig?.defaultEventName ?? defaultEventName;

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
        const destinationFolder = executedResult?.destinationFolder ?? '!TestMove';

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
    },
  });
}


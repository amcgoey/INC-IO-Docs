import type { HttpRequest, HttpResponse, HttpServer } from '../../../infrastructure/http';
import type { RecordServicePort } from '../../record/ports';
import type { AuthVerifierPort, AuthVerificationResult } from '../ports';
import {
  extractWorkspaceExecutionContext,
  type WorkspaceExecutionContext,
} from '../domain';
import { buildHomepageCard, buildToastNotification } from './cards';

export interface WorkspaceFeatureApiOptions {
  authVerifier: AuthVerifierPort;
  recordService?: RecordServicePort | undefined;
  defaultRecordType?: string | undefined;
  defaultEventName?: string | undefined;
}

async function authenticateRequest(
  request: HttpRequest,
  authVerifier: AuthVerifierPort
): Promise<{ authResult: AuthVerificationResult; unauthorizedResponse?: HttpResponse }> {
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
}

export function registerWorkspaceFeatureRoutes(
  router: HttpServer,
  opts: WorkspaceFeatureApiOptions
): void {
  const { authVerifier, recordService, defaultRecordType = 'test-record', defaultEventName = 'onSubmit' } = opts;

  router.registerRoute({
    method: 'POST',
    url: '/workspace/homepage',
    handler: async (request) => {
      try {
        const { unauthorizedResponse } = await authenticateRequest(request, authVerifier);
        if (unauthorizedResponse) {
          return unauthorizedResponse;
        }

        return {
          status: 200,
          body: buildHomepageCard(),
        };
      } catch (error) {
        return {
          status: 500,
          body: {
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'Unknown error in /workspace/homepage',
          },
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

        const selectedItem = context.selectedItems?.[0];
        const initialFileName = selectedItem?.title ?? 'selected file';

        if (recordService) {
          const bodyObj = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
          const recordPayload = bodyObj.record ?? {
            type: defaultRecordType,
            data: {
              title: initialFileName,
            },
          };

          const result = await recordService.processRecord(recordPayload, defaultEventName, context);
          if (!result.success) {
            return {
              status: 400,
              body: {
                success: false,
                errors: result.errors,
              },
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
        return {
          status: 500,
          body: {
            error: 'Internal Server Error',
            message: error instanceof Error ? error.message : 'Unknown error in /workspace/action',
          },
        };
      }
    },
  });
}

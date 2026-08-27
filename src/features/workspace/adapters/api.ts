import type { HttpServer } from '../../../infrastructure/http';
import type { RecordServicePort } from '../../record/ports';
import type { AuthVerifierPort } from '../ports';
import {
  extractWorkspaceExecutionContext,
  buildHomepageCard,
  buildToastNotification,
  type WorkspaceExecutionContext,
} from '../domain';
import type { DriveActivityHandler } from '../../record/adapters/drive-activity-handler';

export interface WorkspaceFeatureApiOptions {
  authVerifier: AuthVerifierPort;
  recordService?: RecordServicePort | undefined;
  driveActivityHandler?: DriveActivityHandler | undefined;
  defaultRecordType?: string | undefined;
  defaultEventName?: string | undefined;
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

        const traceHeader = request.headers?.['x-cloud-trace-context'] as string | undefined;
        const context: WorkspaceExecutionContext & { lastExecutionResult?: { fileName: string; destinationFolder: string } | undefined } =
          extractWorkspaceExecutionContext(request.body, traceHeader);

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

        const executedResult =
          context.lastExecutionResult ?? opts.driveActivityHandler?.getLastExecutionResult();
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

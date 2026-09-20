import type { HttpServer, HttpRequest, HttpResponse } from '../http';
import {
  buildErrorCard,
  type DocumentSelectionState,
} from './ui-blocks';
import {
  extractWorkspaceExecutionContext,
  createWorkspaceDocumentExecutionContext,
  type WorkspaceExecutionContext,
  type WorkspaceDocumentExecutionContext,
} from './context';

export interface WorkspaceAuthVerifier {
  verifyToken(authHeader?: string): Promise<{ isValid: boolean; error?: string | undefined; payload?: unknown }>;
}
export type WorkspaceAuthVerifierPort = WorkspaceAuthVerifier;

export interface WorkspaceConfiguration {
  appTitle?: string | undefined;
  actionButtonText?: string | undefined;
  defaultDocumentType?: string | undefined;
  defaultDocumentSpaceType?: string | undefined;
  defaultEventName?: string | undefined;
}

export interface WorkspaceConfigProvider {
  getWorkspaceConfig(): Promise<WorkspaceConfiguration | undefined>;
}
export type WorkspaceConfigProviderPort = WorkspaceConfigProvider;

export interface WorkspaceDocumentRunner {
  processDocument(
    payload?: unknown,
    eventName?: string,
    context?: WorkspaceDocumentExecutionContext
  ): Promise<{ success: boolean; errors?: string[]; error?: string; outputs?: unknown[] }>;
}
export type WorkspaceDocumentRunnerPort = WorkspaceDocumentRunner;

export interface WorkspaceDocumentSpaceProvider {
  getAllTypes(): {
    id: string;
    displayName: string;
    spaceSchema: { allowedDocumentTypes: string[] };
  }[];
  getCollection(typeId: string): Promise<{
    type?: {
      id: string;
      displayName: string;
      spaceSchema: { allowedDocumentTypes: string[] };
    };
    spaces: { id: string; name: string }[];
  }>;
}
export type WorkspaceDocumentSpaceProviderPort = WorkspaceDocumentSpaceProvider;

export interface WorkspaceProcessCardRequest {
  viewId: string;
  documentTypeKey?: string | undefined;
  selectionState?: DocumentSelectionState | undefined;
  validationErrors?: string[] | undefined;
  formData?: Record<string, unknown> | undefined;
  hiddenFields?: string[] | undefined;
  isUpdateCard?: boolean | undefined;
}

export interface WorkspaceProcessCardOrchestrator {
  generateCard(request: WorkspaceProcessCardRequest): Promise<unknown>;
}
export type WorkspaceProcessCardOrchestratorPort = WorkspaceProcessCardOrchestrator;

export interface WorkspaceManifestProvider {
  getRawManifest(): Promise<unknown>;
  readParsedSchema?(relPath: string): Promise<unknown>;
}
export type WorkspaceManifestProviderPort = WorkspaceManifestProvider;

export interface FormChangeEvaluationResult {
  computedData: Record<string, unknown>;
  hiddenFields: string[];
  disabledFields: string[];
}

export type FormChangeEvaluator = (
  formData: Record<string, unknown>,
  docSchema?: unknown,
  uiSchema?: unknown
) => FormChangeEvaluationResult;

export interface WorkspaceAddonApiOptions {
  authVerifier: WorkspaceAuthVerifier;
  documentService?: WorkspaceDocumentRunner | undefined;
  documentSpaceService?: WorkspaceDocumentSpaceProvider | undefined;
  configProvider?: WorkspaceConfigProvider | undefined;
  processCardOrchestrator?: WorkspaceProcessCardOrchestrator | undefined;
  evaluateFormChange?: FormChangeEvaluator | undefined;
  manifestProvider?: WorkspaceManifestProvider | undefined;
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

async function getDocAndUiSchemas(
  manifestProvider?: WorkspaceManifestProvider,
  documentTypeKey?: string
): Promise<{ docSchema?: unknown; uiSchema?: unknown }> {
  if (!manifestProvider || !documentTypeKey) {
    return {};
  }
  const rawManifest = (await manifestProvider.getRawManifest()) as
    | { documentTypes?: string[] | Record<string, { documentSchema?: unknown; documentUiSchema?: unknown }> }
    | undefined;

  if (!rawManifest) {
    return {};
  }

  if (rawManifest.documentTypes && !Array.isArray(rawManifest.documentTypes) && typeof rawManifest.documentTypes === 'object') {
    const docDef = (rawManifest.documentTypes as Record<string, { documentSchema?: unknown; documentUiSchema?: unknown }>)[documentTypeKey];
    if (docDef) {
      return {
        docSchema: docDef.documentSchema,
        uiSchema: docDef.documentUiSchema,
      };
    }
  }

  if (Array.isArray(rawManifest.documentTypes) && manifestProvider.readParsedSchema) {
    for (const relPath of rawManifest.documentTypes) {
      const rawDoc = (await manifestProvider.readParsedSchema(relPath)) as
        | { key?: string; documentSchema?: unknown; documentUiSchema?: unknown }
        | undefined;
      if (rawDoc?.key === documentTypeKey) {
        return {
          docSchema: rawDoc.documentSchema,
          uiSchema: rawDoc.documentUiSchema,
        };
      }
    }
  }

  return {};
}

export function registerWorkspaceAddonRoutes(
  router: HttpServer,
  opts: WorkspaceAddonApiOptions
): void {
  const {
    authVerifier,
    documentSpaceService,
    configProvider,
  } = opts;

  const prepareDriveDocumentProcessCardContext = async (
    context: WorkspaceExecutionContext,
    overrides?: {
      isUpdateCard?: boolean | undefined;
      formData?: Record<string, unknown> | undefined;
      hiddenFields?: string[] | undefined;
      documentTypeKey?: string | undefined;
    }
  ) => {
    const wsConfig = configProvider ? await configProvider.getWorkspaceConfig() : undefined;

    let spaceTypes: DocumentSelectionState['spaceTypes'] = [];
    let documentTypes: DocumentSelectionState['documentTypes'] = [];
    let spaces: string[] = [];

    const currentSpaceType =
      (context.formData?.SelectDocumentSpaceType as string | undefined) ??
      wsConfig?.defaultDocumentSpaceType ??
      'projects';

    let allowedDocumentTypes: string[] | undefined;

    if (documentSpaceService) {
      const types = documentSpaceService.getAllTypes();
      spaceTypes = types.map((t) => ({
        text: t.displayName,
        value: t.id,
        selected: t.id === currentSpaceType,
      }));

      const selectedType = types.find((t) => t.id === currentSpaceType);
      if (selectedType) {
        allowedDocumentTypes = selectedType.spaceSchema.allowedDocumentTypes;
      }

      try {
        const collection = await documentSpaceService.getCollection(currentSpaceType);
        spaces = collection.spaces.map((s) => s.name);
        if (!allowedDocumentTypes && collection.type) {
          allowedDocumentTypes = collection.type.spaceSchema.allowedDocumentTypes;
        }
      } catch (e) {
        console.warn(`Could not fetch collection for default space type: ${currentSpaceType}`, e);
      }
    }

    const currentDocType =
      overrides?.documentTypeKey ??
      (context.formData?.SelectDocumentType as string | undefined) ??
      wsConfig?.defaultDocumentType;

    if (allowedDocumentTypes && allowedDocumentTypes.length > 0) {
      documentTypes = allowedDocumentTypes.map((typeKey) => ({
        text: typeKey,
        value: typeKey,
        selected: typeKey === currentDocType,
      }));
    }

    const selectionContext: DocumentSelectionState = {
      spaceTypes,
      spaces,
      documentTypes,
    };

    if (opts.processCardOrchestrator) {
      const selectedDocType =
        currentDocType ??
        documentTypes.find((d) => d.selected)?.value ??
        documentTypes[0]?.value;

      const effectiveFormData = overrides?.formData ?? context.formData;
      return await opts.processCardOrchestrator.generateCard({
        viewId: 'drive-document-process-card',
        documentTypeKey: selectedDocType,
        selectionState: selectionContext,
        ...(context.validationErrors && context.validationErrors.length > 0
          ? { validationErrors: context.validationErrors }
          : {}),
        ...(effectiveFormData !== undefined ? { formData: effectiveFormData } : {}),
        ...(overrides?.hiddenFields !== undefined ? { hiddenFields: overrides.hiddenFields } : {}),
        ...(overrides?.isUpdateCard !== undefined ? { isUpdateCard: overrides.isUpdateCard } : {}),
      });
    }

    return buildErrorCard('Process card orchestrator not configured');
  };

  const handleFormChange = async (context: WorkspaceExecutionContext): Promise<HttpResponse> => {
    try {
      const selectedDocType =
        (context.formData?.SelectDocumentType as string | undefined) ??
        (context.parameters?.documentTypeKey as string | undefined);

      const { docSchema, uiSchema } = await getDocAndUiSchemas(opts.manifestProvider, selectedDocType);
      const evaluation = opts.evaluateFormChange
        ? opts.evaluateFormChange(context.formData ?? {}, docSchema, uiSchema)
        : { computedData: context.formData ?? {}, hiddenFields: [], disabledFields: [] };

      if (opts.processCardOrchestrator) {
        const card = await prepareDriveDocumentProcessCardContext(context, {
          isUpdateCard: true,
          formData: evaluation.computedData,
          hiddenFields: evaluation.hiddenFields,
          documentTypeKey: selectedDocType,
        });
        return {
          status: 200,
          body: card,
        };
      }

      return {
        status: 200,
        body: await prepareDriveDocumentProcessCardContext(context),
      };
    } catch (error) {
      return {
        status: 200,
        body: buildErrorCard(
          error instanceof Error ? error.message : 'Unknown error in onFormChange'
        ),
      };
    }
  };

  const handleAction = async (context: WorkspaceExecutionContext): Promise<HttpResponse> => {
    const actionName = context.actionName ?? context.parameters?.action;

    if (actionName === 'onFormChange') {
      return await handleFormChange(context);
    }

    if (actionName === 'processDocument') {
      const selectedDocType =
        (context.formData?.SelectDocumentType as string | undefined) ??
        (context.parameters?.documentTypeKey as string | undefined);
      const selectedSpace = context.formData?.SelectDocumentSpace as string | undefined;

      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(context.formData ?? {})) {
        if (!k.startsWith('SelectDocument')) {
          data[k] = v;
        }
      }

      try {
        if (opts.documentService) {
          const execContext = createWorkspaceDocumentExecutionContext(context);
          const result = await opts.documentService.processDocument(
            {
              type: selectedDocType ?? 'default',
              data,
              ...(selectedSpace ? { space: selectedSpace } : {}),
            },
            'onSubmit',
            execContext
          );

          if (result && result.success === false) {
            const validationErrors =
              result.errors ??
              (result.error ? [result.error] : ['Document validation failed']);
            const card = await prepareDriveDocumentProcessCardContext({
              ...context,
              validationErrors,
            }, {
              isUpdateCard: true,
              formData: context.formData,
              documentTypeKey: selectedDocType,
            });
            return {
              status: 200,
              body: card,
            };
          }
        }

        return {
          status: 200,
          body: {
            action: {
              notification: {
                text: 'Document processed successfully',
              },
            },
          },
        };
      } catch (error) {
        const validationErrors = [error instanceof Error ? error.message : 'Document processing failed'];
        const card = await prepareDriveDocumentProcessCardContext({
          ...context,
          validationErrors,
        }, {
          isUpdateCard: true,
          formData: context.formData,
          documentTypeKey: selectedDocType,
        });
        return {
          status: 200,
          body: card,
        };
      }
    }

    return {
      status: 200,
      body: buildErrorCard(`Unknown action: ${actionName ?? 'unspecified'}`),
    };
  };

  const createProcessCardRouteHandler = (endpointName: string) =>
    withAuthentication(authVerifier, async (request) => {
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
          body: buildErrorCard(
            error instanceof Error ? error.message : `Unknown error in ${endpointName}`
          ),
        };
      }
    });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/drive-items-selected',
    handler: createProcessCardRouteHandler('/workspace/drive-items-selected'),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/homepage',
    handler: createProcessCardRouteHandler('/workspace/homepage'),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/on-form-change',
    handler: withAuthentication(authVerifier, async (request) => {
      const traceHeader = request.headers?.['x-cloud-trace-context'] as string | undefined;
      const context = extractWorkspaceExecutionContext(request.body, traceHeader);
      return await handleFormChange(context);
    }),
  });

  router.registerRoute({
    method: 'POST',
    url: '/workspace/action',
    handler: withAuthentication(authVerifier, async (request) => {
      const traceHeader = request.headers?.['x-cloud-trace-context'] as string | undefined;
      const context = extractWorkspaceExecutionContext(request.body, traceHeader);
      return await handleAction(context);
    }),
  });
}

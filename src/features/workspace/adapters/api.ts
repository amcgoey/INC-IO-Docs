import type {
  AuthVerifierPort,
  DocumentSelectionState,
  WorkspaceConfigProviderPort,
  WorkspaceDocumentRunnerPort,
  WorkspaceProcessCardOrchestratorPort,
  WorkspaceSchemaQueryPort,
  WorkspaceUiBuilderPort,
} from '../ports';
import {
  extractWorkspaceExecutionContext,
  createWorkspaceDocumentExecutionContext,
  type WorkspaceExecutionContext,
} from '../domain';
import { buildDriveDocumentProcessCard } from './drive-document-process-card';
import { evaluateFormChange } from '../../../infrastructure/workspace-addon/json-logic-evaluator';

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
  schemaQuery?: WorkspaceSchemaQueryPort | undefined;
  documentSpaceService?: import('../ports').WorkspaceDocumentSpaceProviderPort | undefined;
  configProvider?: WorkspaceConfigProviderPort | undefined;
  processCardOrchestrator?: WorkspaceProcessCardOrchestratorPort | undefined;
  manifestProvider?: {
    getRawManifest(): Promise<unknown>;
    readParsedSchema?(relPath: string): Promise<unknown>;
  } | undefined;
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

async function getDocAndUiSchemas(
  manifestProvider?: {
    getRawManifest(): Promise<unknown>;
    readParsedSchema?(relPath: string): Promise<unknown>;
  },
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

  // Case 1: documentTypes is an object/record keyed by doc type key
  if (rawManifest.documentTypes && !Array.isArray(rawManifest.documentTypes) && typeof rawManifest.documentTypes === 'object') {
    const docDef = (rawManifest.documentTypes as Record<string, { documentSchema?: unknown; documentUiSchema?: unknown }>)[documentTypeKey];
    if (docDef) {
      return {
        docSchema: docDef.documentSchema,
        uiSchema: docDef.documentUiSchema,
      };
    }
  }

  // Case 2: documentTypes is an array of paths and readParsedSchema is available
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

export function registerWorkspaceFeatureRoutes(
  router: HttpServer,
  opts: WorkspaceFeatureApiOptions
): void {
  const {
    authVerifier,
    uiBuilder,
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

    if (opts.schemaQuery?.getForms) {
      const forms = await opts.schemaQuery.getForms();
      const filteredForms = allowedDocumentTypes
        ? forms.filter((f) => allowedDocumentTypes.includes(f.key))
        : forms;

      documentTypes = filteredForms.map((f) => ({
        text: f.name,
        value: f.key,
        selected: f.key === currentDocType,
      }));
    } else if (allowedDocumentTypes && allowedDocumentTypes.length > 0) {
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

    return buildDriveDocumentProcessCard(context.selectedItems, wsConfig, uiBuilder, {
      selectionContext,
    });
  };

  const handleFormChange = async (context: WorkspaceExecutionContext): Promise<HttpResponse> => {
    try {
      const selectedDocType =
        (context.formData?.SelectDocumentType as string | undefined) ??
        (context.parameters?.documentTypeKey as string | undefined);

      const { docSchema, uiSchema } = await getDocAndUiSchemas(opts.manifestProvider, selectedDocType);
      const evaluation = evaluateFormChange(context.formData ?? {}, docSchema, uiSchema);

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
        body: uiBuilder.buildErrorCard(
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
              (result as { errors?: string[] }).errors ??
              ((result as { error?: string }).error ? [(result as { error?: string }).error!] : ['Document validation failed']);
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
      body: uiBuilder.buildErrorCard(`Unknown action: ${actionName ?? 'unspecified'}`),
    };
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
        const wsConfig = configProvider ? await configProvider.getWorkspaceConfig() : undefined;

        return {
          status: 200,
          body: buildDriveDocumentProcessCard(context.selectedItems, wsConfig, uiBuilder),
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

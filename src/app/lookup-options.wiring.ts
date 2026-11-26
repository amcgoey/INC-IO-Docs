import {
  DriveOptionSourceAdapter,
  LookupOptionsService,
  ManifestLookupSchemaAdapter,
  type DocumentLogOptionSourcePort,
  type DriveFolderListClient,
  type LookupDocumentSchema,
  type LookupManifestPort,
  type LookupOptionsPort,
  type LookupSpaceContext,
  type RawLookupManifestProviderPort,
} from '../features/lookup-options';
import {
  DocumentLogConfigurationError,
  type DocumentLogPort,
} from '../features/document-log';
import type { DocumentSpaceService } from '../features/document-space/domain';
import type {
  DocumentDynamicValidationPort,
  DocumentSchemaRegistryPort,
  DynamicValidationResult,
} from '../features/document/ports';
import type {
  DynamicOptionResolution,
  OptionsFetcherPort,
} from '../features/schema-driven-ui/ports';
import type { CanonicalOptionsProviderPort } from '../features/source-parser/ports';
import type { UiProcessLockedFieldsPort } from '../features/ui-process-manager/ports';
import type { AppConfigurationProviderPort } from '../features/document/ports';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';

export type SpaceLookupResolver = (
  spaceId: string,
  formData?: Readonly<Record<string, unknown>>
) => Promise<LookupSpaceContext | undefined>;

export interface LookupOptionsWiringOptions {
  manifestProvider?: RawLookupManifestProviderPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  driveClient?: DriveFolderListClient | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  documentLogService?: DocumentLogPort | undefined;
  getDocumentLogService?: ((context: WorkspaceExecutionContext) => DocumentLogPort) | undefined;
  ensureDocumentLogInitialized?: (() => Promise<void>) | undefined;
  getDocumentSpaceService?:
    | ((context: WorkspaceExecutionContext) => Promise<DocumentSpaceService> | DocumentSpaceService)
    | undefined;
  timeoutMs?: number | undefined;
}

export interface LookupOptionsWiring {
  createLookupOptions(context?: WorkspaceExecutionContext): LookupOptionsPort;
  getPerRequestLookupOptions(context: WorkspaceExecutionContext): LookupOptionsPort;
  createOptionsFetcher(context: WorkspaceExecutionContext): OptionsFetcherPort;
  createDynamicValidator(context: WorkspaceExecutionContext): DocumentDynamicValidationPort;
  createCanonicalOptionsProvider(context: WorkspaceExecutionContext): CanonicalOptionsProviderPort;
  createLockedFieldsResolver(context: WorkspaceExecutionContext): UiProcessLockedFieldsPort;
}

function createLookupManifestPortFromRegistry(
  registry: DocumentSchemaRegistryPort
): LookupManifestPort {
  let cachedSchemasPromise: Promise<Map<string, LookupDocumentSchema>> | undefined;
  return {
    getDocumentSchema: async (documentTypeKey: string) => {
      if (!cachedSchemasPromise) {
        cachedSchemasPromise = registry
          .loadAll()
          .then((docTypes) => {
            const map = new Map<string, LookupDocumentSchema>();
            for (const docType of docTypes) {
              map.set(docType.key, {
                fields: docType.documentSchema.fields.map((f) => ({
                  key: f.key,
                  ...(f.options !== undefined ? { options: f.options } : {}),
                  ...(f.linkedField !== undefined ? { linkedField: f.linkedField } : {}),
                })),
                ...(docType.documentSchema.options !== undefined
                  ? { options: docType.documentSchema.options }
                  : {}),
                ...(docType.documentSchema.optionSources !== undefined
                  ? { optionSources: docType.documentSchema.optionSources }
                  : {}),
              });
            }
            return map;
          })
          .catch((error) => {
            cachedSchemasPromise = undefined;
            throw error;
          });
      }
      const map = await cachedSchemasPromise;
      return map.get(documentTypeKey);
    },
  };
}

function createEmptyManifestPort(): LookupManifestPort {
  return {
    getDocumentSchema: async () => undefined,
  };
}

function createLookupManifestPort(options: {
  manifestProvider?: RawLookupManifestProviderPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
}): LookupManifestPort {
  if (options.manifestProvider) {
    return new ManifestLookupSchemaAdapter(options.manifestProvider);
  }
  if (options.documentSchemaRegistry) {
    return createLookupManifestPortFromRegistry(options.documentSchemaRegistry);
  }
  return createEmptyManifestPort();
}

function createDocumentLogOptionSourceAdapter(
  getDocumentLogService: () => DocumentLogPort,
  ensureInitialized?: () => Promise<void>,
  resolveSpace?: SpaceLookupResolver
): DocumentLogOptionSourcePort {
  return {
    readOptionTables: async (params) => {
      try {
        if (ensureInitialized) {
          await ensureInitialized();
        }
        let resolvedSpace = params.space;
        if (
          resolvedSpace &&
          (!resolvedSpace.typeId || !resolvedSpace.name) &&
          resolveSpace
        ) {
          const lookedUp = await resolveSpace(resolvedSpace.id);
          if (lookedUp) {
            resolvedSpace = lookedUp;
          }
        }
        const service = getDocumentLogService();
        if (!service.readOptionTables) {
          return {
            status: 'config_error',
            errorMessage: 'DocumentLogPort.readOptionTables is not implemented.',
            tables: {},
          };
        }
        return await service.readOptionTables({
          documentTypeKey: params.documentTypeKey,
          ...(resolvedSpace !== undefined ? { space: resolvedSpace } : {}),
          ...(params.selectedLogId !== undefined ? { selectedLogId: params.selectedLogId } : {}),
          ...(params.sourceKeys !== undefined ? { sourceKeys: [...params.sourceKeys] } : {}),
        });
      } catch (error) {
        if (error instanceof DocumentLogConfigurationError) {
          return {
            status: 'config_error',
            errorMessage: error.message,
            tables: {},
          };
        }
        throw error;
      }
    },
  };
}

function createSpaceLookupResolver(
  getSpaceService?: () => Promise<DocumentSpaceService> | DocumentSpaceService
): SpaceLookupResolver | undefined {
  if (!getSpaceService) {
    return undefined;
  }
  return async (spaceId: string, formData?: Readonly<Record<string, unknown>>) => {
    const trimmed = spaceId.trim();
    if (!trimmed) {
      return undefined;
    }
    const spaceService = await getSpaceService();
    const allTypes = spaceService.getAllTypes();
    const rawPreferredType = formData?.SelectDocumentSpaceType;
    const preferredTypeId =
      typeof rawPreferredType === 'string' && rawPreferredType.trim().length > 0
        ? rawPreferredType.trim()
        : undefined;

    const orderedTypeIds: string[] = [];
    if (preferredTypeId && allTypes.some((t) => t.id === preferredTypeId)) {
      orderedTypeIds.push(preferredTypeId);
    }
    for (const spaceType of allTypes) {
      if (spaceType.id !== preferredTypeId) {
        orderedTypeIds.push(spaceType.id);
      }
    }

    for (const typeId of orderedTypeIds) {
      try {
        const collection = await spaceService.getCollection(typeId);
        const found = collection.spaces.find(
          (s) => s.id === trimmed || s.abstractStorageId === trimmed
        );
        if (found) {
          return {
            id: found.id,
            typeId: found.typeId,
            name: found.name,
            abstractStorageId: found.abstractStorageId,
          };
        }
      } catch {
        // Ignore unrelated space collection errors
      }
    }

    return undefined;
  };
}

async function resolveLookupSpace(
  rawSpaceId: string | undefined,
  explicitSpace: LookupSpaceContext | undefined,
  formData: Readonly<Record<string, unknown>> | undefined,
  resolveSpace?: SpaceLookupResolver
): Promise<LookupSpaceContext | undefined> {
  if (explicitSpace) {
    return explicitSpace;
  }
  const trimmedSpace = rawSpaceId?.trim();
  if (!trimmedSpace) {
    return undefined;
  }
  if (resolveSpace) {
    const resolved = await resolveSpace(trimmedSpace, formData);
    if (resolved) {
      return resolved;
    }
  }
  return { id: trimmedSpace, abstractStorageId: trimmedSpace };
}

export function createOptionsFetcherAdapter(
  lookupOptions: LookupOptionsPort,
  resolveSpace?: SpaceLookupResolver
): OptionsFetcherPort {
  return {
    fetchOptions: async (queries, context) => {
      const results: Record<string, DynamicOptionResolution> = {};
      if (!context.documentTypeKey) {
        for (const query of queries) {
          results[query.sourceKey] = { status: 'empty', items: [] };
        }
        return results;
      }

      const space = await resolveLookupSpace(
        context.spaceId,
        undefined,
        context.formData,
        resolveSpace
      );
      const rawSelectedLog =
        context.selectedLogId ??
        (typeof context.formData?.SelectDocumentLog === 'string'
          ? context.formData.SelectDocumentLog
          : undefined);
      const trimmedLogId =
        typeof rawSelectedLog === 'string' && rawSelectedLog.trim().length > 0
          ? rawSelectedLog.trim()
          : undefined;

      const resolved = await lookupOptions.resolveOptions(
        {
          ...(space !== undefined ? { space } : {}),
          documentTypeKey: context.documentTypeKey,
          ...(trimmedLogId !== undefined ? { selectedLogId: trimmedLogId } : {}),
        },
        queries.map((q) => q.sourceKey)
      );

      for (const query of queries) {
        const res = resolved[query.sourceKey];
        if (!res) {
          results[query.sourceKey] = { status: 'empty', items: [] };
          continue;
        }
        results[query.sourceKey] = {
          status: res.status,
          items: res.items,
          ...(res.targetPath !== undefined ? { targetPath: res.targetPath } : {}),
          ...(res.errorMessage !== undefined ? { errorMessage: res.errorMessage } : {}),
        };
      }

      return results;
    },
  };
}

export function createDocumentDynamicValidationAdapter(
  lookupOptions: LookupOptionsPort,
  resolveSpace?: SpaceLookupResolver
): DocumentDynamicValidationPort {
  return {
    validateExistence: async (queries, context) => {
      const space = await resolveLookupSpace(
        context.spaceId,
        context.space,
        context.formData,
        resolveSpace
      );
      const rawSelectedLog =
        context.selectedLogId ??
        (typeof context.formData?.SelectDocumentLog === 'string'
          ? context.formData.SelectDocumentLog
          : undefined);
      const trimmedLogId =
        typeof rawSelectedLog === 'string' && rawSelectedLog.trim().length > 0
          ? rawSelectedLog.trim()
          : undefined;

      const resolved = await lookupOptions.validateFields(
        {
          ...(space !== undefined ? { space } : {}),
          documentTypeKey: context.documentTypeKey ?? '',
          ...(trimmedLogId !== undefined ? { selectedLogId: trimmedLogId } : {}),
        },
        queries.map((q) => ({
          queryId: q.queryId,
          fieldKey: q.fieldKey ?? q.queryId,
          sourceKey: q.sourceKey,
          value: q.valueToValidate,
          ...(q.allowUserInput !== undefined ? { allowUserInput: q.allowUserInput } : {}),
        }))
      );

      const results: Record<string, DynamicValidationResult> = {};
      for (const [queryId, res] of Object.entries(resolved)) {
        results[queryId] = {
          isValid: res.isValid,
          status: res.status,
          ...(res.targetPath !== undefined ? { targetPath: res.targetPath } : {}),
          ...(res.matchedTuple !== undefined ? { matchedTuple: res.matchedTuple } : {}),
          ...(res.errorMessage !== undefined ? { errorMessage: res.errorMessage } : {}),
        };
      }
      return results;
    },
  };
}

export function createCanonicalOptionsProviderAdapter(
  lookupOptions: LookupOptionsPort,
  resolveSpace?: SpaceLookupResolver
): CanonicalOptionsProviderPort {
  return {
    getCanonicalOptions: async (spaceId, field, documentTypeKey, selectedLogId) => {
      const space = await resolveLookupSpace(spaceId, undefined, undefined, resolveSpace);
      if (!space || !documentTypeKey) {
        return [];
      }
      return lookupOptions.getCanonicalOptions(
        {
          space,
          documentTypeKey,
          ...(selectedLogId !== undefined ? { selectedLogId } : {}),
        },
        field.key
      );
    },
  };
}

export function createUiProcessLockedFieldsAdapter(
  lookupOptions: LookupOptionsPort,
  resolveSpace?: SpaceLookupResolver
): UiProcessLockedFieldsPort {
  return {
    deriveLockedFields: async ({ documentTypeKey, space, selectedLogId, formData }) => {
      const explicitSpace: LookupSpaceContext | undefined = space
        ? {
            id: space.id,
            typeId: space.typeId,
            name: space.name,
            abstractStorageId: space.abstractStorageId,
          }
        : undefined;
      const resolvedSpace = await resolveLookupSpace(
        typeof formData.spaceId === 'string' ? formData.spaceId : undefined,
        explicitSpace,
        formData,
        resolveSpace
      );
      return lookupOptions.deriveLockedFields(
        {
          ...(resolvedSpace !== undefined ? { space: resolvedSpace } : {}),
          documentTypeKey,
          ...(selectedLogId !== undefined ? { selectedLogId } : {}),
        },
        formData
      );
    },
  };
}

export function createLookupOptionsService(
  options: LookupOptionsWiringOptions
): LookupOptionsPort {
  const manifestPort = createLookupManifestPort({
    manifestProvider: options.manifestProvider,
    documentSchemaRegistry: options.documentSchemaRegistry,
  });
  const driveClient =
    options.driveClient ??
    new GoogleDriveClient({
      ...(options.configProvider !== undefined ? { configProvider: options.configProvider } : {}),
    });

  const documentLogOptionSource = options.documentLogService
    ? createDocumentLogOptionSourceAdapter(
        () => options.documentLogService!,
        options.ensureDocumentLogInitialized
      )
    : undefined;

  return new LookupOptionsService(manifestPort, {
    driveOptionSource: new DriveOptionSourceAdapter(driveClient),
    ...(documentLogOptionSource !== undefined ? { documentLogOptionSource } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

export function createLookupOptionsWiring(
  options: LookupOptionsWiringOptions
): LookupOptionsWiring {
  const manifestPort = createLookupManifestPort({
    manifestProvider: options.manifestProvider,
    documentSchemaRegistry: options.documentSchemaRegistry,
  });
  const perRequestInstances = new WeakMap<WorkspaceExecutionContext, LookupOptionsPort>();

  const getSpaceResolver = (context: WorkspaceExecutionContext): SpaceLookupResolver | undefined =>
    options.getDocumentSpaceService
      ? createSpaceLookupResolver(() => options.getDocumentSpaceService!(context))
      : undefined;

  const createLookupOptions = (context?: WorkspaceExecutionContext): LookupOptionsPort => {
    const oauthCredential = context?.userOAuthToken ?? context?.gmail?.accessToken;
    const driveClient: DriveFolderListClient = oauthCredential
      ? new GoogleDriveClient({
          auth: oauthCredential,
          configProvider: options.configProvider,
        })
      : (options.driveClient ??
          new GoogleDriveClient({ configProvider: options.configProvider }));

    const spaceResolver = context ? getSpaceResolver(context) : undefined;
    const documentLogOptionSource =
      context && options.getDocumentLogService
        ? createDocumentLogOptionSourceAdapter(
            () => options.getDocumentLogService!(context),
            options.ensureDocumentLogInitialized,
            spaceResolver
          )
        : options.documentLogService
          ? createDocumentLogOptionSourceAdapter(
              () => options.documentLogService!,
              options.ensureDocumentLogInitialized,
              spaceResolver
            )
          : undefined;

    return new LookupOptionsService(manifestPort, {
      driveOptionSource: new DriveOptionSourceAdapter(driveClient),
      ...(documentLogOptionSource !== undefined ? { documentLogOptionSource } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  };

  const getPerRequestLookupOptions = (context: WorkspaceExecutionContext): LookupOptionsPort => {
    let instance = perRequestInstances.get(context);
    if (!instance) {
      instance = createLookupOptions(context);
      perRequestInstances.set(context, instance);
    }
    return instance;
  };

  return {
    createLookupOptions,
    getPerRequestLookupOptions,
    createOptionsFetcher: (context) =>
      createOptionsFetcherAdapter(getPerRequestLookupOptions(context)),
    createDynamicValidator: (context) =>
      createDocumentDynamicValidationAdapter(getPerRequestLookupOptions(context)),
    createCanonicalOptionsProvider: (context) =>
      createCanonicalOptionsProviderAdapter(getPerRequestLookupOptions(context)),
    createLockedFieldsResolver: (context) =>
      createUiProcessLockedFieldsAdapter(getPerRequestLookupOptions(context)),
  };
}

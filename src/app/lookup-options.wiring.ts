import {
  DriveOptionSourceAdapter,
  LookupOptionsService,
  ManifestLookupSchemaAdapter,
  type DriveFolderListClient,
  type LookupDocumentSchema,
  type LookupManifestPort,
  type LookupOptionsPort,
  type RawLookupManifestProviderPort,
} from '../features/lookup-options';
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
import type { AppConfigurationProviderPort } from '../features/document/ports';
import { GoogleDriveClient } from '../infrastructure/drive/drive-client';
import type { WorkspaceExecutionContext } from '../infrastructure/workspace-addon/context';

export interface LookupOptionsWiringOptions {
  manifestProvider?: RawLookupManifestProviderPort | undefined;
  documentSchemaRegistry?: DocumentSchemaRegistryPort | undefined;
  driveClient?: DriveFolderListClient | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  timeoutMs?: number | undefined;
}

export interface LookupOptionsWiring {
  createLookupOptions(context?: WorkspaceExecutionContext): LookupOptionsPort;
  getPerRequestLookupOptions(context: WorkspaceExecutionContext): LookupOptionsPort;
  createOptionsFetcher(context: WorkspaceExecutionContext): OptionsFetcherPort;
  createDynamicValidator(context: WorkspaceExecutionContext): DocumentDynamicValidationPort;
  createCanonicalOptionsProvider(context: WorkspaceExecutionContext): CanonicalOptionsProviderPort;
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

export function createOptionsFetcherAdapter(
  lookupOptions: LookupOptionsPort
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

      const trimmedSpace = context.spaceId?.trim();
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
          ...(trimmedSpace ? { space: { id: trimmedSpace, abstractStorageId: trimmedSpace } } : {}),
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
        };
      }

      return results;
    },
  };
}

export function createDocumentDynamicValidationAdapter(
  lookupOptions: LookupOptionsPort
): DocumentDynamicValidationPort {
  return {
    validateExistence: async (queries, context) => {
      const trimmedSpace = context.spaceId?.trim();
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
          ...(trimmedSpace ? { space: { id: trimmedSpace, abstractStorageId: trimmedSpace } } : {}),
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
  lookupOptions: LookupOptionsPort
): CanonicalOptionsProviderPort {
  return {
    getCanonicalOptions: async (spaceId, field, documentTypeKey, selectedLogId) => {
      const trimmedSpace = spaceId?.trim();
      if (!trimmedSpace || !documentTypeKey) {
        return [];
      }
      return lookupOptions.getCanonicalOptions(
        {
          space: { id: trimmedSpace, abstractStorageId: trimmedSpace },
          documentTypeKey,
          ...(selectedLogId !== undefined ? { selectedLogId } : {}),
        },
        field.key
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

  return new LookupOptionsService(manifestPort, {
    driveOptionSource: new DriveOptionSourceAdapter(driveClient),
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

  const createLookupOptions = (context?: WorkspaceExecutionContext): LookupOptionsPort => {
    const oauthCredential = context?.userOAuthToken ?? context?.gmail?.accessToken;
    const driveClient: DriveFolderListClient = oauthCredential
      ? new GoogleDriveClient({
          auth: oauthCredential,
          configProvider: options.configProvider,
        })
      : (options.driveClient ??
          new GoogleDriveClient({ configProvider: options.configProvider }));

    return new LookupOptionsService(manifestPort, {
      driveOptionSource: new DriveOptionSourceAdapter(driveClient),
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
  };
}
